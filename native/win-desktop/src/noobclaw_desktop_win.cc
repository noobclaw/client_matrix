// NoobClaw Windows native desktop automation addon.
//
// Replaces the PowerShell-subprocess fallbacks in
// src/main/libs/desktopControlMcp.ts (Add-Type + System.Drawing +
// SendKeys) with direct Win32 calls. Load via the same mechanism as
// the macOS .mm addon (src/main/libs/nativeDesktopWin.ts).
//
// Exports (all sync):
//
//   screenshot({format?, quality?}) -> { data: Buffer, width, height, format }
//   mouseMove(x, y, options?)
//   mouseClick(x, y, button?, clickCount?)
//   keyType(text)
//   keyPress(key, modifiers?)
//   clipboardGet() -> string
//   clipboardSet(text) -> boolean
//   clipboardVerify(expected) -> boolean
//   getActiveWindow() -> { title, pid, className }
//   listWindows() -> [{ title, pid, className }]
//
// Not implemented on Windows (no direct equivalent API exists without
// significant work): OCR (Vision framework), NLEmbedding (Natural
// Language), Keychain (use kernel32 DPAPI separately), AX tree
// (UI Automation requires COM setup and isn't trivially sync),
// Touch ID (Windows Hello is a separate COM API), Sleep/wake
// (WM_POWERBROADCAST — separate file). Callers should continue
// falling through to the existing Node-level paths for those.
//
// Thread safety: Win32 input / GDI / clipboard must run on a STA
// thread. The Node main thread is STA by default for addons, so
// calling these directly from the sidecar JS thread is fine.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellscalingapi.h>
#include <gdiplus.h>
#include <powrprof.h>
#include <powerbase.h>

#include <napi.h>

#include <algorithm>
#include <memory>
#include <string>
#include <vector>

#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "shcore.lib")
#pragma comment(lib, "powrprof.lib")

// ─── GDI+ lifetime ──────────────────────────────────────────────────

static ULONG_PTR g_gdiplusToken = 0;

static void InitGdiPlusOnce() {
  if (g_gdiplusToken != 0) return;
  Gdiplus::GdiplusStartupInput input;
  Gdiplus::GdiplusStartup(&g_gdiplusToken, &input, nullptr);
}

// ─── Helpers ────────────────────────────────────────────────────────

static std::wstring Utf8ToWide(const std::string &s) {
  if (s.empty()) return std::wstring();
  int len = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring out(len, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), out.data(), len);
  return out;
}

static std::string WideToUtf8(const std::wstring &w) {
  if (w.empty()) return std::string();
  int len = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(),
                                nullptr, 0, nullptr, nullptr);
  std::string out(len, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), out.data(), len,
                      nullptr, nullptr);
  return out;
}

// Encode a GDI+ bitmap to PNG or JPEG bytes in memory via a CLSID
// lookup. Returns an empty vector on failure.
static int FindEncoderClsid(const WCHAR *mime, CLSID *out) {
  UINT num = 0, size = 0;
  Gdiplus::GetImageEncodersSize(&num, &size);
  if (size == 0) return -1;
  std::vector<BYTE> buf(size);
  auto *info = reinterpret_cast<Gdiplus::ImageCodecInfo *>(buf.data());
  Gdiplus::GetImageEncoders(num, size, info);
  for (UINT i = 0; i < num; i++) {
    if (wcscmp(info[i].MimeType, mime) == 0) {
      *out = info[i].Clsid;
      return (int)i;
    }
  }
  return -1;
}

static std::vector<uint8_t> EncodeBitmap(Gdiplus::Bitmap &bmp,
                                         const std::string &format,
                                         double quality) {
  std::vector<uint8_t> out;

  const WCHAR *mime =
      (format == "png") ? L"image/png" : L"image/jpeg";
  CLSID clsid;
  if (FindEncoderClsid(mime, &clsid) < 0) return out;

  IStream *stream = nullptr;
  if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &stream))) return out;

  Gdiplus::EncoderParameters params;
  params.Count = 1;
  params.Parameter[0].Guid = Gdiplus::EncoderQuality;
  params.Parameter[0].Type = Gdiplus::EncoderParameterValueTypeLong;
  params.Parameter[0].NumberOfValues = 1;
  LONG q = (LONG)std::max(0.0, std::min(100.0, quality * 100));
  params.Parameter[0].Value = &q;

  Gdiplus::Status st =
      (format == "png") ? bmp.Save(stream, &clsid, nullptr)
                        : bmp.Save(stream, &clsid, &params);
  if (st != Gdiplus::Ok) {
    stream->Release();
    return out;
  }

  HGLOBAL mem = nullptr;
  GetHGlobalFromStream(stream, &mem);
  if (mem) {
    SIZE_T sz = GlobalSize(mem);
    void *ptr = GlobalLock(mem);
    if (ptr) {
      out.assign((const uint8_t *)ptr, (const uint8_t *)ptr + sz);
      GlobalUnlock(mem);
    }
  }
  stream->Release();
  return out;
}

// ─── Screenshot ────────────────────────────────────────────────────

static Napi::Value Screenshot(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  std::string format = "jpeg";
  double quality = 0.75;
  if (info.Length() > 0 && info[0].IsObject()) {
    Napi::Object opts = info[0].As<Napi::Object>();
    if (opts.Has("format")) {
      format = opts.Get("format").As<Napi::String>().Utf8Value();
    }
    if (opts.Has("quality")) {
      quality = opts.Get("quality").As<Napi::Number>().DoubleValue();
    }
  }

  // Make the process DPI-aware so BitBlt captures at the real pixel
  // resolution on high-DPI displays. Safe to call multiple times;
  // we ignore failures (the default mode still captures, just scaled).
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  int width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  int height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  int origin_x = GetSystemMetrics(SM_XVIRTUALSCREEN);
  int origin_y = GetSystemMetrics(SM_YVIRTUALSCREEN);

  HDC screen_dc = GetDC(nullptr);
  if (!screen_dc) {
    Napi::Error::New(env, "GetDC(nullptr) failed").ThrowAsJavaScriptException();
    return env.Null();
  }
  HDC mem_dc = CreateCompatibleDC(screen_dc);
  HBITMAP bmp = CreateCompatibleBitmap(screen_dc, width, height);
  HGDIOBJ old_bmp = SelectObject(mem_dc, bmp);

  BOOL ok = BitBlt(mem_dc, 0, 0, width, height, screen_dc, origin_x, origin_y,
                   SRCCOPY | CAPTUREBLT);

  SelectObject(mem_dc, old_bmp);
  DeleteDC(mem_dc);
  ReleaseDC(nullptr, screen_dc);

  if (!ok) {
    DeleteObject(bmp);
    Napi::Error::New(env, "BitBlt failed").ThrowAsJavaScriptException();
    return env.Null();
  }

  InitGdiPlusOnce();
  Gdiplus::Bitmap gdiBmp(bmp, nullptr);
  auto bytes = EncodeBitmap(gdiBmp, format, quality);
  DeleteObject(bmp);

  if (bytes.empty()) {
    Napi::Error::New(env, "EncodeBitmap failed").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Buffer<uint8_t> buffer =
      Napi::Buffer<uint8_t>::Copy(env, bytes.data(), bytes.size());
  Napi::Object result = Napi::Object::New(env);
  result.Set("data", buffer);
  result.Set("width", Napi::Number::New(env, width));
  result.Set("height", Napi::Number::New(env, height));
  result.Set("format", Napi::String::New(env, format));
  return result;
}

// ─── Mouse ──────────────────────────────────────────────────────────

// Convert absolute virtual-screen coordinates to the SendInput
// normalized-coordinate space (0..65535 across the virtual desktop).
static void VirtualScreenToAbs(int x, int y, LONG *nx, LONG *ny) {
  int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
  int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
  int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  int vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  if (vw <= 0) vw = 1;
  if (vh <= 0) vh = 1;
  *nx = (LONG)(((double)(x - vx) / vw) * 65535.0);
  *ny = (LONG)(((double)(y - vy) / vh) * 65535.0);
}

static void SendMouseMoveAbs(int x, int y) {
  INPUT input = {};
  input.type = INPUT_MOUSE;
  LONG nx, ny;
  VirtualScreenToAbs(x, y, &nx, &ny);
  input.mi.dx = nx;
  input.mi.dy = ny;
  input.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
  SendInput(1, &input, sizeof(INPUT));
}

static Napi::Value MouseMove(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "mouseMove(x, y, opts?): x, y required")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  int x = info[0].As<Napi::Number>().Int32Value();
  int y = info[1].As<Napi::Number>().Int32Value();

  int durationMs = 0;
  if (info.Length() > 2 && info[2].IsObject()) {
    Napi::Object opts = info[2].As<Napi::Object>();
    if (opts.Has("durationMs")) {
      durationMs = opts.Get("durationMs").As<Napi::Number>().Int32Value();
    }
  }

  if (durationMs <= 0) {
    SendMouseMoveAbs(x, y);
    return env.Undefined();
  }

  // Animate in 16ms steps with ease-out-cubic. We don't read the
  // starting position via GetCursorPos because the caller typically
  // passes the next target; an instant move is usually fine.
  POINT start;
  GetCursorPos(&start);
  int steps = std::max(2, durationMs / 16);
  for (int i = 1; i <= steps; i++) {
    double t = (double)i / (double)steps;
    double u = 1.0 - t;
    double eased = 1.0 - u * u * u;
    int px = (int)(start.x + (x - start.x) * eased);
    int py = (int)(start.y + (y - start.y) * eased);
    SendMouseMoveAbs(px, py);
    Sleep(16);
  }
  return env.Undefined();
}

static Napi::Value MouseClick(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "mouseClick(x, y, button?, clicks?) requires x, y")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  int x = info[0].As<Napi::Number>().Int32Value();
  int y = info[1].As<Napi::Number>().Int32Value();

  std::string button = "left";
  int clicks = 1;
  if (info.Length() > 2 && info[2].IsString()) {
    button = info[2].As<Napi::String>().Utf8Value();
  }
  if (info.Length() > 3 && info[3].IsNumber()) {
    clicks = info[3].As<Napi::Number>().Int32Value();
  }
  if (clicks < 1) clicks = 1;
  if (clicks > 5) clicks = 5;

  DWORD downFlag = MOUSEEVENTF_LEFTDOWN;
  DWORD upFlag = MOUSEEVENTF_LEFTUP;
  if (button == "right") {
    downFlag = MOUSEEVENTF_RIGHTDOWN;
    upFlag = MOUSEEVENTF_RIGHTUP;
  } else if (button == "middle") {
    downFlag = MOUSEEVENTF_MIDDLEDOWN;
    upFlag = MOUSEEVENTF_MIDDLEUP;
  }

  SendMouseMoveAbs(x, y);

  for (int i = 0; i < clicks; i++) {
    INPUT seq[2] = {};
    seq[0].type = INPUT_MOUSE;
    seq[0].mi.dwFlags = downFlag;
    seq[1].type = INPUT_MOUSE;
    seq[1].mi.dwFlags = upFlag;
    SendInput(2, seq, sizeof(INPUT));
    if (i < clicks - 1) Sleep(50);
  }
  return env.Undefined();
}

// ─── Keyboard ───────────────────────────────────────────────────────

// Send a single Unicode codepoint via KEYEVENTF_UNICODE. Handles
// surrogate pairs by sending both halves.
static void SendUnicodeCodepoint(wchar_t ch) {
  INPUT seq[2] = {};
  seq[0].type = INPUT_KEYBOARD;
  seq[0].ki.wScan = ch;
  seq[0].ki.dwFlags = KEYEVENTF_UNICODE;
  seq[1].type = INPUT_KEYBOARD;
  seq[1].ki.wScan = ch;
  seq[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
  SendInput(2, seq, sizeof(INPUT));
}

static Napi::Value KeyType(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "keyType(text) requires a string")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string utf8 = info[0].As<Napi::String>().Utf8Value();
  std::wstring wide = Utf8ToWide(utf8);
  for (wchar_t ch : wide) {
    SendUnicodeCodepoint(ch);
    Sleep(3);
  }
  return env.Undefined();
}

// Virtual key code map for common named keys.
static WORD KeyCodeForName(const std::string &nameIn) {
  std::string n;
  n.reserve(nameIn.size());
  for (char c : nameIn) n += (char)tolower((unsigned char)c);

  if (n == "enter" || n == "return") return VK_RETURN;
  if (n == "tab") return VK_TAB;
  if (n == "space") return VK_SPACE;
  if (n == "escape" || n == "esc") return VK_ESCAPE;
  if (n == "backspace" || n == "delete") return VK_BACK;
  if (n == "forwarddelete" || n == "del") return VK_DELETE;
  if (n == "up") return VK_UP;
  if (n == "down") return VK_DOWN;
  if (n == "left") return VK_LEFT;
  if (n == "right") return VK_RIGHT;
  if (n == "home") return VK_HOME;
  if (n == "end") return VK_END;
  if (n == "pageup") return VK_PRIOR;
  if (n == "pagedown") return VK_NEXT;
  if (n == "f1") return VK_F1;
  if (n == "f2") return VK_F2;
  if (n == "f3") return VK_F3;
  if (n == "f4") return VK_F4;
  if (n == "f5") return VK_F5;
  if (n == "f6") return VK_F6;
  if (n == "f7") return VK_F7;
  if (n == "f8") return VK_F8;
  if (n == "f9") return VK_F9;
  if (n == "f10") return VK_F10;
  if (n == "f11") return VK_F11;
  if (n == "f12") return VK_F12;
  if (n.size() == 1) {
    char c = n[0];
    if (c >= 'a' && c <= 'z') return (WORD)('A' + (c - 'a'));
    if (c >= '0' && c <= '9') return (WORD)('0' + (c - '0'));
  }
  return 0;
}

static void SendVkPress(WORD vk, bool down) {
  INPUT input = {};
  input.type = INPUT_KEYBOARD;
  input.ki.wVk = vk;
  input.ki.dwFlags = down ? 0 : KEYEVENTF_KEYUP;
  SendInput(1, &input, sizeof(INPUT));
}

static Napi::Value KeyPress(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "keyPress(key, modifiers?) requires a key name")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string key = info[0].As<Napi::String>().Utf8Value();

  // Modifier flags — we press each modifier down, then the main key,
  // then release everything in reverse.
  std::vector<WORD> mods;
  if (info.Length() > 1 && info[1].IsArray()) {
    Napi::Array arr = info[1].As<Napi::Array>();
    for (uint32_t i = 0; i < arr.Length(); i++) {
      Napi::Value v = arr.Get(i);
      if (!v.IsString()) continue;
      std::string m = v.As<Napi::String>().Utf8Value();
      for (auto &c : m) c = (char)tolower((unsigned char)c);
      if (m == "ctrl" || m == "control") mods.push_back(VK_CONTROL);
      else if (m == "shift") mods.push_back(VK_SHIFT);
      else if (m == "alt" || m == "option") mods.push_back(VK_MENU);
      else if (m == "cmd" || m == "meta" || m == "win" || m == "command")
        mods.push_back(VK_LWIN);
    }
  }

  WORD vk = KeyCodeForName(key);
  if (vk == 0) {
    std::string msg = "Unknown key: " + key;
    Napi::Error::New(env, msg.c_str()).ThrowAsJavaScriptException();
    return env.Null();
  }

  for (WORD m : mods) SendVkPress(m, true);
  SendVkPress(vk, true);
  Sleep(10);
  SendVkPress(vk, false);
  for (auto it = mods.rbegin(); it != mods.rend(); ++it) SendVkPress(*it, false);
  return env.Undefined();
}

// ─── Clipboard ──────────────────────────────────────────────────────

static Napi::Value ClipboardGet(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (!OpenClipboard(nullptr)) {
    return Napi::String::New(env, "");
  }
  HANDLE h = GetClipboardData(CF_UNICODETEXT);
  std::string out;
  if (h) {
    const wchar_t *w = (const wchar_t *)GlobalLock(h);
    if (w) {
      std::wstring ws(w);
      out = WideToUtf8(ws);
      GlobalUnlock(h);
    }
  }
  CloseClipboard();
  return Napi::String::New(env, out);
}

static Napi::Value ClipboardSet(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "clipboardSet(text) requires a string")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string utf8 = info[0].As<Napi::String>().Utf8Value();
  std::wstring wide = Utf8ToWide(utf8);
  if (!OpenClipboard(nullptr)) return Napi::Boolean::New(env, false);
  EmptyClipboard();
  SIZE_T bytes = (wide.size() + 1) * sizeof(wchar_t);
  HGLOBAL mem = GlobalAlloc(GMEM_MOVEABLE, bytes);
  if (!mem) {
    CloseClipboard();
    return Napi::Boolean::New(env, false);
  }
  wchar_t *p = (wchar_t *)GlobalLock(mem);
  memcpy(p, wide.c_str(), bytes);
  GlobalUnlock(mem);
  BOOL ok = SetClipboardData(CF_UNICODETEXT, mem) != nullptr;
  CloseClipboard();
  return Napi::Boolean::New(env, ok ? true : false);
}

static Napi::Value ClipboardVerify(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "clipboardVerify(expected) requires a string")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string expected = info[0].As<Napi::String>().Utf8Value();
  Napi::Value got = ClipboardGet(info);
  if (!got.IsString()) return Napi::Boolean::New(env, false);
  return Napi::Boolean::New(env, got.As<Napi::String>().Utf8Value() == expected);
}

// ─── Active window / window list ────────────────────────────────────

static std::string WindowTitleUtf8(HWND hwnd) {
  int len = GetWindowTextLengthW(hwnd);
  if (len <= 0) return std::string();
  std::wstring buf(len + 1, L'\0');
  GetWindowTextW(hwnd, buf.data(), len + 1);
  buf.resize(len);
  return WideToUtf8(buf);
}

static std::string WindowClassUtf8(HWND hwnd) {
  wchar_t buf[256] = {0};
  int n = GetClassNameW(hwnd, buf, 256);
  if (n <= 0) return std::string();
  return WideToUtf8(std::wstring(buf, n));
}

// Renamed from `GetActiveWindow` — that name collides with user32.h's
// `HWND GetActiveWindow(void)` and MSVC refuses to take the address at
// Napi::Function::New with "overloaded-function" (C2665). Our function
// and the Win32 one have different signatures, but C++ overload
// resolution at &-taking time can't pick one, so we rename.
static Napi::Value JSGetActiveWindow(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  HWND hwnd = GetForegroundWindow();
  if (!hwnd) return env.Null();

  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);

  Napi::Object out = Napi::Object::New(env);
  out.Set("title", Napi::String::New(env, WindowTitleUtf8(hwnd)));
  out.Set("className", Napi::String::New(env, WindowClassUtf8(hwnd)));
  out.Set("pid", Napi::Number::New(env, (double)pid));
  return out;
}

struct EnumCtx {
  Napi::Env env;
  Napi::Array out;
  uint32_t idx;
};

static BOOL CALLBACK EnumVisibleWindowsProc(HWND hwnd, LPARAM lparam) {
  if (!IsWindowVisible(hwnd)) return TRUE;
  if (GetWindowTextLengthW(hwnd) == 0) return TRUE;

  auto *ctx = reinterpret_cast<EnumCtx *>(lparam);
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);

  Napi::HandleScope scope(ctx->env);
  Napi::Object w = Napi::Object::New(ctx->env);
  w.Set("title", Napi::String::New(ctx->env, WindowTitleUtf8(hwnd)));
  w.Set("className", Napi::String::New(ctx->env, WindowClassUtf8(hwnd)));
  w.Set("pid", Napi::Number::New(ctx->env, (double)pid));
  ctx->out.Set(ctx->idx++, w);
  return TRUE;
}

static Napi::Value ListWindows(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  Napi::Array out = Napi::Array::New(env);
  EnumCtx ctx{env, out, 0};
  EnumWindows(EnumVisibleWindowsProc, reinterpret_cast<LPARAM>(&ctx));
  return out;
}

// ─── Sleep / Wake events ────────────────────────────────────────────
//
// Registers a callback for Windows power-state transitions via
// PowerRegisterSuspendResumeNotification (Vista+, stable on Win8+). The
// system calls DeviceNotifyCallbackRoutine on a worker thread when it is
// about to suspend (PBT_APMSUSPEND) and again after it resumes
// (PBT_APMRESUMESUSPEND / PBT_APMRESUMEAUTOMATIC). We forward those
// events to the JS callback via a thread-safe function so the sidecar
// can pause / resume cowork sessions in lockstep with the OS.
//
// Parity with the macOS addon's `onPowerEvent`: callback receives the
// string "willSleep" or "didWake". Only one subscription is supported
// at a time — calling onPowerEvent again just replaces the stored
// thread-safe function (the native Windows subscription is created
// once and reused).

static HPOWERNOTIFY g_power_notify_handle = nullptr;
static Napi::ThreadSafeFunction g_power_tsfn;
static bool g_power_tsfn_valid = false;

// Name avoids collision with Windows SDK — `OnPowerEvent` and
// `PowerCallbackRoutine` are both reserved-ish in the power framework
// headers, and MSVC emits "overloaded-function" errors if we try to
// take their address from &.
static ULONG CALLBACK NoobClawPowerCallback(PVOID /*Context*/, ULONG Type, PVOID /*Setting*/) {
  if (!g_power_tsfn_valid) return 0;

  const char *kind = nullptr;
  switch (Type) {
    case PBT_APMSUSPEND:
      kind = "willSleep";
      break;
    case PBT_APMRESUMEAUTOMATIC:
    case PBT_APMRESUMESUSPEND:
      kind = "didWake";
      break;
    default:
      return 0;
  }

  // Copy the string into a heap slot so the TSFN callback can own it
  // past the return of this callback. The JS-side trampoline frees it
  // after invoking the user's JS callback.
  std::string *payload = new std::string(kind);
  napi_status status = g_power_tsfn.NonBlockingCall(payload,
    [](Napi::Env env, Napi::Function jsCallback, std::string *data) {
      if (data) {
        jsCallback.Call({ Napi::String::New(env, *data) });
        delete data;
      }
    });
  if (status != napi_ok) {
    delete payload;
  }
  return 0;
}

static Napi::Value OnPowerEventJS(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "onPowerEvent requires a function").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Replace any prior subscription: release the old TSFN before
  // creating a new one so the old JS callback can be GC'd.
  if (g_power_tsfn_valid) {
    g_power_tsfn.Release();
    g_power_tsfn_valid = false;
  }

  g_power_tsfn = Napi::ThreadSafeFunction::New(
    env,
    info[0].As<Napi::Function>(),
    "noobclaw_power_event",
    0,  // unlimited queue
    1); // single thread uses it
  g_power_tsfn_valid = true;

  // Register with the OS only on the first call. Re-registering on
  // every call would leak handles since we never unregister from
  // Windows until process exit (acceptable — we want events for the
  // whole process lifetime).
  if (!g_power_notify_handle) {
    DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS params = {};
    params.Callback = NoobClawPowerCallback;
    params.Context = nullptr;
    ULONG rc = PowerRegisterSuspendResumeNotification(
      DEVICE_NOTIFY_CALLBACK,
      reinterpret_cast<HANDLE>(&params),
      &g_power_notify_handle);
    if (rc != ERROR_SUCCESS) {
      // Subscription failed — release the TSFN so we don't leak it
      // and return false so the caller knows to fall back (e.g. to
      // a polling approach). Most commonly fails on unsupported OS
      // versions, which we don't officially target anyway.
      g_power_tsfn.Release();
      g_power_tsfn_valid = false;
      g_power_notify_handle = nullptr;
      return Napi::Boolean::New(env, false);
    }
  }

  return Napi::Boolean::New(env, true);
}

// ─── Module init ────────────────────────────────────────────────────

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("screenshot", Napi::Function::New(env, Screenshot));
  exports.Set("mouseMove", Napi::Function::New(env, MouseMove));
  exports.Set("mouseClick", Napi::Function::New(env, MouseClick));
  exports.Set("keyType", Napi::Function::New(env, KeyType));
  exports.Set("keyPress", Napi::Function::New(env, KeyPress));
  exports.Set("clipboardGet", Napi::Function::New(env, ClipboardGet));
  exports.Set("clipboardSet", Napi::Function::New(env, ClipboardSet));
  exports.Set("clipboardVerify", Napi::Function::New(env, ClipboardVerify));
  exports.Set("getActiveWindow", Napi::Function::New(env, JSGetActiveWindow));
  exports.Set("listWindows", Napi::Function::New(env, ListWindows));
  exports.Set("onPowerEvent", Napi::Function::New(env, OnPowerEventJS));
  return exports;
}

NODE_API_MODULE(noobclaw_desktop_win, Init)
