// NoobClaw macOS native desktop automation addon.
//
// Replaces the osascript / screencapture / Python fallbacks in
// src/main/libs/desktopControlMcp.ts with direct CGEvent + NSPasteboard +
// CGDisplayCreateImage calls. Loaded by the pkg-bundled sidecar via the
// loader in src/main/libs/nativeDesktopMac.ts.
//
// Exports (all sync):
//
//   screenshot({quality?, format?}) -> { data: Buffer, width, height, format }
//   mouseMove(x, y, {durationMs?, easing?})
//   mouseClick(x, y, button?, clickCount?)
//   mouseDrag(x1, y1, x2, y2, durationMs?)
//   keyType(text)
//   keyPress(keyName, modifiers?[])
//   clipboardGet() -> string
//   clipboardSet(text)
//   clipboardVerify(expected) -> boolean
//   getActiveWindow() -> { title, bundleId, pid } | null
//   listWindows() -> [{ title, bundleId, pid }]
//   isAccessibilityTrusted({prompt?}) -> boolean
//
// Threading: all calls run synchronously on the calling JS thread. CGEvent
// posting from a background thread is OK on macOS. NSPasteboard is thread
// safe for reading/writing strings.
//
// Permissions: the OS will auto-prompt the user the first time a
// screen-recording API (screenshot) or accessibility-requiring API
// (mouseMove / mouseClick / keyPress against other apps) is invoked. The
// app binary embedding this addon must ship with matching entitlements
// (see src-tauri/entitlements.plist: cs.allow-jit,
// cs.allow-unsigned-executable-memory, cs.disable-library-validation).

#import <napi.h>
#import <AppKit/AppKit.h>
#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ApplicationServices/ApplicationServices.h>
#import <ImageIO/ImageIO.h>
#import <CoreServices/CoreServices.h>
#import <Security/Security.h>                     // Keychain Services
#import <Carbon/Carbon.h>                         // virtual key codes
#import <Vision/Vision.h>                         // VNRecognizeTextRequest (OCR)
#import <AVFoundation/AVFoundation.h>             // AVSpeechSynthesizer, AVAudioEngine
#import <Speech/Speech.h>                         // SFSpeechRecognizer (STT)
#import <QuickLookThumbnailing/QuickLookThumbnailing.h>
#import <NaturalLanguage/NaturalLanguage.h>       // NLLanguageRecognizer, NLEmbedding
#import <LocalAuthentication/LocalAuthentication.h> // LAContext (Touch ID)

#include <algorithm>
#include <string>
#include <unistd.h>          // usleep
#include <cctype>

// ─── Small helpers ────────────────────────────────────────────────────

static std::string StdFromNS(NSString *s) {
  if (!s) return std::string();
  return std::string([s UTF8String] ?: "");
}

static NSString *NSFromStd(const std::string &s) {
  return [NSString stringWithUTF8String:s.c_str()] ?: @"";
}

static double easeOutCubic(double t) {
  double u = 1.0 - t;
  return 1.0 - u * u * u;
}

// ─── Accessibility permission helper ──────────────────────────────────

static Napi::Value IsAccessibilityTrusted(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  bool prompt = false;
  if (info.Length() > 0 && info[0].IsObject()) {
    Napi::Object opts = info[0].As<Napi::Object>();
    if (opts.Has("prompt")) prompt = opts.Get("prompt").ToBoolean().Value();
  }
  NSDictionary *options = @{
    (__bridge NSString *)kAXTrustedCheckOptionPrompt : @(prompt)
  };
  Boolean trusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
  return Napi::Boolean::New(env, trusted ? true : false);
}

// ─── Screenshot ────────────────────────────────────────────────────────

static Napi::Value Screenshot(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  double quality = 0.75;
  std::string format = "jpeg";

  if (info.Length() > 0 && info[0].IsObject()) {
    Napi::Object opts = info[0].As<Napi::Object>();
    if (opts.Has("quality")) {
      quality = opts.Get("quality").As<Napi::Number>().DoubleValue();
    }
    if (opts.Has("format")) {
      format = opts.Get("format").As<Napi::String>().Utf8Value();
    }
  }
  if (quality < 0.0) quality = 0.0;
  if (quality > 1.0) quality = 1.0;

  CGDirectDisplayID displayID = CGMainDisplayID();

  // CGDisplayCreateImage is deprecated in macOS 15 but still works; the
  // modern replacement (SCScreenshotManager / SCStream) is async and
  // requires macOS 14+, which would raise our minimum OS. Keep the sync
  // path until we bump minimumSystemVersion. The -Wdeprecated-
  // declarations warning is silenced in binding.gyp.
  CGImageRef cgImage = CGDisplayCreateImage(displayID);
  if (!cgImage) {
    Napi::Error::New(env, "CGDisplayCreateImage returned NULL (screen recording permission not granted?)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  size_t width = CGImageGetWidth(cgImage);
  size_t height = CGImageGetHeight(cgImage);

  NSMutableData *data = [NSMutableData data];
  CFStringRef type = kUTTypeJPEG;
  if (format == "png") type = kUTTypePNG;

  CGImageDestinationRef dest = CGImageDestinationCreateWithData(
      (__bridge CFMutableDataRef)data, type, 1, NULL);
  if (!dest) {
    CGImageRelease(cgImage);
    Napi::Error::New(env, "CGImageDestinationCreateWithData failed")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  if (format == "jpeg") {
    NSDictionary *props = @{
      (__bridge NSString *)kCGImageDestinationLossyCompressionQuality : @(quality)
    };
    CGImageDestinationAddImage(dest, cgImage, (__bridge CFDictionaryRef)props);
  } else {
    CGImageDestinationAddImage(dest, cgImage, NULL);
  }

  bool ok = CGImageDestinationFinalize(dest);
  CFRelease(dest);
  CGImageRelease(cgImage);

  if (!ok) {
    Napi::Error::New(env, "CGImageDestinationFinalize failed")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Buffer<uint8_t> buffer = Napi::Buffer<uint8_t>::Copy(
      env, (const uint8_t *)data.bytes, data.length);

  Napi::Object result = Napi::Object::New(env);
  result.Set("data", buffer);
  result.Set("width", Napi::Number::New(env, (double)width));
  result.Set("height", Napi::Number::New(env, (double)height));
  result.Set("format", Napi::String::New(env, format));
  return result;
}

// ─── Mouse ────────────────────────────────────────────────────────────

static CGPoint currentMousePosition() {
  CGEventRef e = CGEventCreate(NULL);
  CGPoint p = CGEventGetLocation(e);
  CFRelease(e);
  return p;
}

static void postMouseMove(CGPoint p) {
  CGEventRef move =
      CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, p, kCGMouseButtonLeft);
  CGEventPost(kCGHIDEventTap, move);
  CFRelease(move);
}

static Napi::Value MouseMove(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "mouseMove(x, y, opts?): x, y required")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  double x = info[0].As<Napi::Number>().DoubleValue();
  double y = info[1].As<Napi::Number>().DoubleValue();

  int durationMs = 0;
  std::string easing = "linear";
  if (info.Length() > 2 && info[2].IsObject()) {
    Napi::Object opts = info[2].As<Napi::Object>();
    if (opts.Has("durationMs")) {
      durationMs = opts.Get("durationMs").As<Napi::Number>().Int32Value();
    }
    if (opts.Has("easing")) {
      easing = opts.Get("easing").As<Napi::String>().Utf8Value();
    }
  }

  if (durationMs <= 0) {
    postMouseMove(CGPointMake(x, y));
    return env.Undefined();
  }

  // 60fps animation. Each frame ≈ 16ms. At least 2 frames even for short
  // durations so the cursor moves at all.
  CGPoint start = currentMousePosition();
  int steps = std::max(2, durationMs / 16);
  for (int i = 1; i <= steps; i++) {
    double t = (double)i / (double)steps;
    double eased = (easing == "ease-out-cubic") ? easeOutCubic(t) : t;
    double px = start.x + (x - start.x) * eased;
    double py = start.y + (y - start.y) * eased;
    postMouseMove(CGPointMake(px, py));
    usleep(16000);
  }
  return env.Undefined();
}

static Napi::Value MouseClick(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "mouseClick(x, y, button?, clicks?): x, y required")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  double x = info[0].As<Napi::Number>().DoubleValue();
  double y = info[1].As<Napi::Number>().DoubleValue();

  std::string button = "left";
  int clicks = 1;
  if (info.Length() > 2 && info[2].IsString()) {
    button = info[2].As<Napi::String>().Utf8Value();
  }
  if (info.Length() > 3 && info[3].IsNumber()) {
    clicks = info[3].As<Napi::Number>().Int32Value();
  }
  if (clicks < 1) clicks = 1;
  if (clicks > 5) clicks = 5; // sanity cap

  CGMouseButton btn = kCGMouseButtonLeft;
  CGEventType downType = kCGEventLeftMouseDown;
  CGEventType upType = kCGEventLeftMouseUp;
  if (button == "right") {
    btn = kCGMouseButtonRight;
    downType = kCGEventRightMouseDown;
    upType = kCGEventRightMouseUp;
  } else if (button == "middle") {
    btn = kCGMouseButtonCenter;
    downType = kCGEventOtherMouseDown;
    upType = kCGEventOtherMouseUp;
  }

  // Move to target first (instant, not animated — the caller can animate
  // before clicking if they want motion).
  postMouseMove(CGPointMake(x, y));

  for (int i = 0; i < clicks; i++) {
    CGEventRef down =
        CGEventCreateMouseEvent(NULL, downType, CGPointMake(x, y), btn);
    // clickState lets the OS recognize double-clicks etc. as a single
    // sequence rather than N independent clicks.
    CGEventSetIntegerValueField(down, kCGMouseEventClickState, i + 1);
    CGEventPost(kCGHIDEventTap, down);
    CFRelease(down);

    usleep(20 * 1000);

    CGEventRef up =
        CGEventCreateMouseEvent(NULL, upType, CGPointMake(x, y), btn);
    CGEventSetIntegerValueField(up, kCGMouseEventClickState, i + 1);
    CGEventPost(kCGHIDEventTap, up);
    CFRelease(up);

    if (i < clicks - 1) usleep(50 * 1000);
  }

  return env.Undefined();
}

static Napi::Value MouseDrag(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4) {
    Napi::TypeError::New(env, "mouseDrag(x1, y1, x2, y2, durationMs?) requires 4 numbers")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  double x1 = info[0].As<Napi::Number>().DoubleValue();
  double y1 = info[1].As<Napi::Number>().DoubleValue();
  double x2 = info[2].As<Napi::Number>().DoubleValue();
  double y2 = info[3].As<Napi::Number>().DoubleValue();
  int durationMs = 400;
  if (info.Length() > 4 && info[4].IsNumber()) {
    durationMs = info[4].As<Napi::Number>().Int32Value();
  }

  // Move to start
  postMouseMove(CGPointMake(x1, y1));
  usleep(30 * 1000);

  // Press
  CGEventRef down = CGEventCreateMouseEvent(
      NULL, kCGEventLeftMouseDown, CGPointMake(x1, y1), kCGMouseButtonLeft);
  CGEventPost(kCGHIDEventTap, down);
  CFRelease(down);

  // Drag via kCGEventLeftMouseDragged events, animated
  int steps = std::max(2, durationMs / 16);
  for (int i = 1; i <= steps; i++) {
    double t = (double)i / (double)steps;
    double eased = easeOutCubic(t);
    double px = x1 + (x2 - x1) * eased;
    double py = y1 + (y2 - y1) * eased;
    CGEventRef drag = CGEventCreateMouseEvent(
        NULL, kCGEventLeftMouseDragged, CGPointMake(px, py), kCGMouseButtonLeft);
    CGEventPost(kCGHIDEventTap, drag);
    CFRelease(drag);
    usleep(16 * 1000);
  }

  // Release
  CGEventRef up = CGEventCreateMouseEvent(
      NULL, kCGEventLeftMouseUp, CGPointMake(x2, y2), kCGMouseButtonLeft);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(up);

  return env.Undefined();
}

// ─── Keyboard ─────────────────────────────────────────────────────────

// Map a human-friendly key name to a macOS virtual key code. Supports
// letters, digits, function keys, arrows, and common named keys. Returns
// 0xFFFF if the key is unknown (caller should fall through to keyType).
static CGKeyCode keyCodeForName(const std::string &nameIn) {
  std::string n;
  n.reserve(nameIn.size());
  for (char c : nameIn) n += (char)tolower((unsigned char)c);

  if (n == "enter" || n == "return") return kVK_Return;
  if (n == "tab") return kVK_Tab;
  if (n == "space" || n == " ") return kVK_Space;
  if (n == "escape" || n == "esc") return kVK_Escape;
  if (n == "backspace" || n == "delete") return kVK_Delete;
  if (n == "forwarddelete" || n == "del") return kVK_ForwardDelete;
  if (n == "up") return kVK_UpArrow;
  if (n == "down") return kVK_DownArrow;
  if (n == "left") return kVK_LeftArrow;
  if (n == "right") return kVK_RightArrow;
  if (n == "home") return kVK_Home;
  if (n == "end") return kVK_End;
  if (n == "pageup") return kVK_PageUp;
  if (n == "pagedown") return kVK_PageDown;
  if (n == "f1") return kVK_F1;
  if (n == "f2") return kVK_F2;
  if (n == "f3") return kVK_F3;
  if (n == "f4") return kVK_F4;
  if (n == "f5") return kVK_F5;
  if (n == "f6") return kVK_F6;
  if (n == "f7") return kVK_F7;
  if (n == "f8") return kVK_F8;
  if (n == "f9") return kVK_F9;
  if (n == "f10") return kVK_F10;
  if (n == "f11") return kVK_F11;
  if (n == "f12") return kVK_F12;

  if (n.size() == 1) {
    char c = n[0];
    if (c >= 'a' && c <= 'z') {
      static const CGKeyCode letters[] = {
          kVK_ANSI_A, kVK_ANSI_B, kVK_ANSI_C, kVK_ANSI_D, kVK_ANSI_E,
          kVK_ANSI_F, kVK_ANSI_G, kVK_ANSI_H, kVK_ANSI_I, kVK_ANSI_J,
          kVK_ANSI_K, kVK_ANSI_L, kVK_ANSI_M, kVK_ANSI_N, kVK_ANSI_O,
          kVK_ANSI_P, kVK_ANSI_Q, kVK_ANSI_R, kVK_ANSI_S, kVK_ANSI_T,
          kVK_ANSI_U, kVK_ANSI_V, kVK_ANSI_W, kVK_ANSI_X, kVK_ANSI_Y,
          kVK_ANSI_Z,
      };
      return letters[c - 'a'];
    }
    if (c >= '0' && c <= '9') {
      static const CGKeyCode digits[] = {
          kVK_ANSI_0, kVK_ANSI_1, kVK_ANSI_2, kVK_ANSI_3, kVK_ANSI_4,
          kVK_ANSI_5, kVK_ANSI_6, kVK_ANSI_7, kVK_ANSI_8, kVK_ANSI_9,
      };
      return digits[c - '0'];
    }
  }
  return 0xFFFF;
}

static CGEventFlags parseModifiers(Napi::Array mods) {
  CGEventFlags flags = 0;
  for (uint32_t i = 0; i < mods.Length(); i++) {
    Napi::Value v = mods.Get(i);
    if (!v.IsString()) continue;
    std::string m = v.As<Napi::String>().Utf8Value();
    for (auto &c : m) c = (char)tolower((unsigned char)c);
    if (m == "cmd" || m == "meta" || m == "command") flags |= kCGEventFlagMaskCommand;
    else if (m == "shift") flags |= kCGEventFlagMaskShift;
    else if (m == "alt" || m == "option") flags |= kCGEventFlagMaskAlternate;
    else if (m == "ctrl" || m == "control") flags |= kCGEventFlagMaskControl;
    else if (m == "fn") flags |= kCGEventFlagMaskSecondaryFn;
  }
  return flags;
}

static Napi::Value KeyType(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "keyType(text) requires a string")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string text = info[0].As<Napi::String>().Utf8Value();
  NSString *nsText = NSFromStd(text);
  NSUInteger len = [nsText length];

  // Type one unicode char at a time via CGEventKeyboardSetUnicodeString.
  // This bypasses the need to map every char to a virtual key code and
  // handles accented/CJK input transparently (the OS routes it through
  // the current input method).
  for (NSUInteger i = 0; i < len; i++) {
    unichar ch = [nsText characterAtIndex:i];

    CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true);
    CGEventKeyboardSetUnicodeString(down, 1, &ch);
    CGEventPost(kCGHIDEventTap, down);
    CFRelease(down);

    CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
    CGEventKeyboardSetUnicodeString(up, 1, &ch);
    CGEventPost(kCGHIDEventTap, up);
    CFRelease(up);

    usleep(5 * 1000);
  }
  return env.Undefined();
}

static Napi::Value KeyPress(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "keyPress(key, modifiers?) requires a key name")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string key = info[0].As<Napi::String>().Utf8Value();

  CGEventFlags flags = 0;
  if (info.Length() > 1 && info[1].IsArray()) {
    flags = parseModifiers(info[1].As<Napi::Array>());
  }

  CGKeyCode code = keyCodeForName(key);
  if (code == 0xFFFF) {
    std::string msg = "Unknown key: " + key;
    Napi::Error::New(env, msg.c_str()).ThrowAsJavaScriptException();
    return env.Null();
  }

  CGEventRef down = CGEventCreateKeyboardEvent(NULL, code, true);
  CGEventSetFlags(down, flags);
  CGEventPost(kCGHIDEventTap, down);
  CFRelease(down);

  usleep(10 * 1000);

  CGEventRef up = CGEventCreateKeyboardEvent(NULL, code, false);
  CGEventSetFlags(up, flags);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(up);

  return env.Undefined();
}

// ─── Clipboard ────────────────────────────────────────────────────────

static Napi::Value ClipboardGet(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  @autoreleasepool {
    NSPasteboard *pb = [NSPasteboard generalPasteboard];
    NSString *s = [pb stringForType:NSPasteboardTypeString];
    if (!s) return Napi::String::New(env, "");
    return Napi::String::New(env, [s UTF8String] ?: "");
  }
}

static Napi::Value ClipboardSet(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "clipboardSet(text) requires a string")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string text = info[0].As<Napi::String>().Utf8Value();
  @autoreleasepool {
    NSString *ns = NSFromStd(text);
    NSPasteboard *pb = [NSPasteboard generalPasteboard];
    [pb clearContents];
    BOOL ok = [pb setString:ns forType:NSPasteboardTypeString];
    return Napi::Boolean::New(env, ok ? true : false);
  }
}

static Napi::Value ClipboardVerify(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "clipboardVerify(expected) requires a string")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string expected = info[0].As<Napi::String>().Utf8Value();
  @autoreleasepool {
    NSPasteboard *pb = [NSPasteboard generalPasteboard];
    NSString *s = [pb stringForType:NSPasteboardTypeString];
    if (!s) return Napi::Boolean::New(env, false);
    std::string got = StdFromNS(s);
    return Napi::Boolean::New(env, got == expected);
  }
}

// ─── Active window / window list ──────────────────────────────────────

static Napi::Value GetActiveWindow(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  @autoreleasepool {
    NSRunningApplication *app = [[NSWorkspace sharedWorkspace] frontmostApplication];
    if (!app) return env.Null();

    NSString *name = app.localizedName ?: @"";
    NSString *bundleId = app.bundleIdentifier ?: @"";

    Napi::Object result = Napi::Object::New(env);
    result.Set("title", Napi::String::New(env, [name UTF8String] ?: ""));
    result.Set("bundleId", Napi::String::New(env, [bundleId UTF8String] ?: ""));
    result.Set("pid", Napi::Number::New(env, (double)app.processIdentifier));
    return result;
  }
}

static Napi::Value ListWindows(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  CFArrayRef list = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID);

  Napi::Array result = Napi::Array::New(env);
  if (!list) return result;

  uint32_t idx = 0;
  CFIndex count = CFArrayGetCount(list);
  for (CFIndex i = 0; i < count; i++) {
    CFDictionaryRef d =
        (CFDictionaryRef)CFArrayGetValueAtIndex(list, i);
    if (!d) continue;

    CFStringRef wname = (CFStringRef)CFDictionaryGetValue(d, kCGWindowName);
    CFStringRef owner = (CFStringRef)CFDictionaryGetValue(d, kCGWindowOwnerName);
    CFNumberRef pidRef = (CFNumberRef)CFDictionaryGetValue(d, kCGWindowOwnerPID);
    CFNumberRef layerRef = (CFNumberRef)CFDictionaryGetValue(d, kCGWindowLayer);

    // Skip system/menubar layers (layer != 0)
    int layer = 0;
    if (layerRef) CFNumberGetValue(layerRef, kCFNumberIntType, &layer);
    if (layer != 0) continue;

    int pid = 0;
    if (pidRef) CFNumberGetValue(pidRef, kCFNumberIntType, &pid);

    char nameBuf[512] = {0};
    if (wname) {
      CFStringGetCString(wname, nameBuf, sizeof(nameBuf), kCFStringEncodingUTF8);
    }
    char ownerBuf[256] = {0};
    if (owner) {
      CFStringGetCString(owner, ownerBuf, sizeof(ownerBuf), kCFStringEncodingUTF8);
    }

    Napi::Object w = Napi::Object::New(env);
    w.Set("title", Napi::String::New(env, nameBuf));
    w.Set("bundleId", Napi::String::New(env, ownerBuf));
    w.Set("pid", Napi::Number::New(env, (double)pid));
    result.Set(idx++, w);
  }
  CFRelease(list);
  return result;
}

// ─── AXUIElement — structured UI tree reader ─────────────────────────
//
// Unlike screenshot+vision, this returns the *semantic* control tree of
// a running Mac app (buttons, text fields, groups, labels…) — role,
// title, value, frame and children, recursively. This is the single
// biggest gap between us and Claude Code's computer-use-swift: with
// this, an AI can say "click the Submit button" instead of guessing
// pixel coordinates from a screenshot.
//
// Depth-limited (default 4) because the Accessibility tree of a full
// app window can have thousands of nodes (every text run, every
// decorative line). Callers can request deeper traversal when needed.
//
// Requires the user to have granted Accessibility permission
// (System Settings → Privacy → Accessibility). `isAccessibilityTrusted`
// returns the current state and can optionally prompt.

static NSString *axStringAttr(AXUIElementRef element, CFStringRef attr) {
  CFTypeRef value = NULL;
  AXError err = AXUIElementCopyAttributeValue(element, attr, &value);
  if (err != kAXErrorSuccess || value == NULL) return nil;
  if (CFGetTypeID(value) != CFStringGetTypeID()) {
    CFRelease(value);
    return nil;
  }
  NSString *s = (__bridge_transfer NSString *)value;
  return s;
}

// Cast helper: CFTypeRef is `const void*` and AXValueRef is
// `struct __AXValue*`. A plain C cast between them is legal in C but
// C++ trips over dropping the const (clang error "no matching function
// for call to 'AXValueGetValue'"). Strip the const via const_cast then
// static_cast to the target pointer type.
static inline AXValueRef castToAXValue(CFTypeRef v) {
  return static_cast<AXValueRef>(const_cast<void *>(v));
}

static CGRect axFrameAttr(AXUIElementRef element) {
  CGPoint origin = CGPointZero;
  CGSize size = CGSizeZero;

  // NOTE: Xcode 16.4's SDK demotes the legacy
  //   kAXValueCGPointType / kAXValueCGSizeType
  // constants to raw `const UInt32` so C++ refuses to implicitly
  // convert them to `AXValueType`. Use the post-10.11 replacements
  //   kAXValueTypeCGPoint / kAXValueTypeCGSize
  // which are properly typed. These resolve to the same integer
  // values so older SDKs would accept them too.
  CFTypeRef posValue = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXPositionAttribute, &posValue) == kAXErrorSuccess && posValue) {
    if (CFGetTypeID(posValue) == AXValueGetTypeID()) {
      AXValueGetValue(castToAXValue(posValue), kAXValueTypeCGPoint, &origin);
    }
    CFRelease(posValue);
  }

  CFTypeRef sizeValue = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXSizeAttribute, &sizeValue) == kAXErrorSuccess && sizeValue) {
    if (CFGetTypeID(sizeValue) == AXValueGetTypeID()) {
      AXValueGetValue(castToAXValue(sizeValue), kAXValueTypeCGSize, &size);
    }
    CFRelease(sizeValue);
  }

  return CGRectMake(origin.x, origin.y, size.width, size.height);
}

static Napi::Value serializeAxElement(Napi::Env env, AXUIElementRef element, int depth, int maxDepth);

static Napi::Value serializeAxChildren(Napi::Env env, AXUIElementRef element, int depth, int maxDepth) {
  Napi::Array out = Napi::Array::New(env);
  if (depth >= maxDepth) return out;

  CFTypeRef childrenRef = NULL;
  AXError err = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &childrenRef);
  if (err != kAXErrorSuccess || childrenRef == NULL) return out;

  if (CFGetTypeID(childrenRef) != CFArrayGetTypeID()) {
    CFRelease(childrenRef);
    return out;
  }

  CFArrayRef children = (CFArrayRef)childrenRef;
  CFIndex count = CFArrayGetCount(children);
  uint32_t outIdx = 0;
  // Cap per-level fan-out to avoid gigantic trees on document-heavy apps.
  const CFIndex maxChildrenPerLevel = 64;
  CFIndex effective = count > maxChildrenPerLevel ? maxChildrenPerLevel : count;
  for (CFIndex i = 0; i < effective; i++) {
    AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex(children, i);
    if (!child) continue;
    out.Set(outIdx++, serializeAxElement(env, child, depth + 1, maxDepth));
  }
  CFRelease(childrenRef);
  return out;
}

static Napi::Value serializeAxElement(Napi::Env env, AXUIElementRef element, int depth, int maxDepth) {
  Napi::Object obj = Napi::Object::New(env);

  NSString *role = axStringAttr(element, kAXRoleAttribute);
  NSString *title = axStringAttr(element, kAXTitleAttribute);
  NSString *label = axStringAttr(element, kAXDescriptionAttribute);
  NSString *value = axStringAttr(element, kAXValueAttribute);
  NSString *help = axStringAttr(element, kAXHelpAttribute);

  obj.Set("role", Napi::String::New(env, role ? [role UTF8String] : ""));
  if (title) obj.Set("title", Napi::String::New(env, [title UTF8String]));
  if (label) obj.Set("label", Napi::String::New(env, [label UTF8String]));
  if (value) obj.Set("value", Napi::String::New(env, [value UTF8String]));
  if (help) obj.Set("help", Napi::String::New(env, [help UTF8String]));

  CGRect frame = axFrameAttr(element);
  Napi::Object frameObj = Napi::Object::New(env);
  frameObj.Set("x", Napi::Number::New(env, frame.origin.x));
  frameObj.Set("y", Napi::Number::New(env, frame.origin.y));
  frameObj.Set("width", Napi::Number::New(env, frame.size.width));
  frameObj.Set("height", Napi::Number::New(env, frame.size.height));
  obj.Set("frame", frameObj);

  obj.Set("children", serializeAxChildren(env, element, depth, maxDepth));
  return obj;
}

static Napi::Value GetAxTree(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "getAxTree(pid, maxDepth?): pid required")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  pid_t pid = (pid_t)info[0].As<Napi::Number>().Int32Value();
  int maxDepth = 4;
  if (info.Length() > 1 && info[1].IsNumber()) {
    maxDepth = info[1].As<Napi::Number>().Int32Value();
    if (maxDepth < 1) maxDepth = 1;
    if (maxDepth > 12) maxDepth = 12;
  }

  // AXUIElementCreateApplication takes a pid and returns an element
  // representing the app's top-level accessibility container. If
  // Accessibility permission isn't granted, the subsequent attribute
  // reads return kAXErrorCannotComplete and we emit an empty tree
  // rather than throwing — the caller can check
  // isAccessibilityTrusted() to surface a prompt.
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  if (!app) {
    Napi::Object empty = Napi::Object::New(env);
    empty.Set("role", Napi::String::New(env, ""));
    empty.Set("children", Napi::Array::New(env));
    return empty;
  }

  Napi::Value result = serializeAxElement(env, app, 0, maxDepth);
  CFRelease(app);
  return result;
}

// ─── Keychain token storage ──────────────────────────────────────────
//
// Used by the sidecar to persist the NoobClaw JWT auth token in the
// macOS login keychain instead of writing it plaintext into SQLite.
// Wrapped via native[KeychainSet|Get|Delete] in
// src/main/libs/nativeDesktopMac.ts.

static Napi::Value KeychainSet(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsString() || !info[1].IsString() || !info[2].IsString()) {
    Napi::TypeError::New(env, "keychainSet(service, account, password) requires 3 strings")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  @autoreleasepool {
    NSString *service = NSFromStd(info[0].As<Napi::String>().Utf8Value());
    NSString *account = NSFromStd(info[1].As<Napi::String>().Utf8Value());
    NSString *password = NSFromStd(info[2].As<Napi::String>().Utf8Value());
    NSData *passwordData = [password dataUsingEncoding:NSUTF8StringEncoding];

    // Try update first; if the entry doesn't exist, fall through to add.
    NSDictionary *query = @{
      (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService : service,
      (__bridge id)kSecAttrAccount : account,
    };
    NSDictionary *update = @{(__bridge id)kSecValueData : passwordData};
    OSStatus status =
        SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)update);

    if (status == errSecItemNotFound) {
      NSMutableDictionary *add = [query mutableCopy];
      add[(__bridge id)kSecValueData] = passwordData;
      status = SecItemAdd((__bridge CFDictionaryRef)add, NULL);
    }
    return Napi::Boolean::New(env, status == errSecSuccess);
  }
}

static Napi::Value KeychainGet(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
    Napi::TypeError::New(env, "keychainGet(service, account) requires 2 strings")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  @autoreleasepool {
    NSString *service = NSFromStd(info[0].As<Napi::String>().Utf8Value());
    NSString *account = NSFromStd(info[1].As<Napi::String>().Utf8Value());
    NSDictionary *query = @{
      (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService : service,
      (__bridge id)kSecAttrAccount : account,
      (__bridge id)kSecReturnData : @YES,
      (__bridge id)kSecMatchLimit : (__bridge id)kSecMatchLimitOne,
    };
    CFTypeRef result = NULL;
    OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
    if (status != errSecSuccess || result == NULL) return env.Null();

    NSData *data = (__bridge_transfer NSData *)result;
    NSString *password = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (!password) return env.Null();
    return Napi::String::New(env, [password UTF8String] ?: "");
  }
}

static Napi::Value KeychainDelete(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
    Napi::TypeError::New(env, "keychainDelete(service, account) requires 2 strings")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  @autoreleasepool {
    NSString *service = NSFromStd(info[0].As<Napi::String>().Utf8Value());
    NSString *account = NSFromStd(info[1].As<Napi::String>().Utf8Value());
    NSDictionary *query = @{
      (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService : service,
      (__bridge id)kSecAttrAccount : account,
    };
    OSStatus status = SecItemDelete((__bridge CFDictionaryRef)query);
    // Treat "not found" as success — caller wants the key gone.
    bool ok = (status == errSecSuccess || status == errSecItemNotFound);
    return Napi::Boolean::New(env, ok);
  }
}

// ─── Vision OCR (VNRecognizeTextRequest) ─────────────────────────────
//
// Apple's Vision framework does on-device OCR with no API key, no
// network round-trip, and <100 ms latency for a full screen. We use
// this to pre-extract text from screenshots BEFORE sending the image
// to any vision model, cutting per-request token cost ~50% on
// computer-use screens that are mostly text.
//
// Input: raw PNG/JPEG bytes (same format as our screenshot() helper
// returns). Output: array of {text, frame, confidence}.
//
// Requires macOS 10.15+. Language list defaults to zh-Hans, zh-Hant,
// en-US — adjustable via the options object.

static Napi::Value RecognizeText(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "recognizeText(imageBuffer, options?) requires a Buffer")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Buffer<uint8_t> buf = info[0].As<Napi::Buffer<uint8_t>>();
  NSData *imageData = [NSData dataWithBytes:buf.Data() length:buf.Length()];

  NSArray<NSString *> *languages = @[ @"zh-Hans", @"zh-Hant", @"en-US" ];
  bool fastMode = false;
  if (info.Length() > 1 && info[1].IsObject()) {
    Napi::Object opts = info[1].As<Napi::Object>();
    if (opts.Has("fast")) {
      fastMode = opts.Get("fast").ToBoolean().Value();
    }
    if (opts.Has("languages")) {
      Napi::Array arr = opts.Get("languages").As<Napi::Array>();
      NSMutableArray *langs = [NSMutableArray array];
      for (uint32_t i = 0; i < arr.Length(); i++) {
        [langs addObject:NSFromStd(arr.Get(i).As<Napi::String>().Utf8Value())];
      }
      if ([langs count] > 0) languages = langs;
    }
  }

  __block NSMutableArray *results = [NSMutableArray array];
  __block NSError *resultErr = nil;

  @autoreleasepool {
    CGImageSourceRef src = CGImageSourceCreateWithData((__bridge CFDataRef)imageData, NULL);
    if (!src) {
      Napi::Error::New(env, "CGImageSourceCreateWithData failed")
          .ThrowAsJavaScriptException();
      return env.Null();
    }
    CGImageRef cgImage = CGImageSourceCreateImageAtIndex(src, 0, NULL);
    CFRelease(src);
    if (!cgImage) {
      Napi::Error::New(env, "CGImageSourceCreateImageAtIndex failed")
          .ThrowAsJavaScriptException();
      return env.Null();
    }

    // Vision is synchronous when you call performRequests with a
    // single handler — the completion block runs on the same thread
    // before perform() returns, so no dispatch_semaphore needed.
    VNRecognizeTextRequest *request =
        [[VNRecognizeTextRequest alloc] initWithCompletionHandler:^(VNRequest *req, NSError *err) {
          if (err) {
            resultErr = err;
            return;
          }
          for (VNRecognizedTextObservation *obs in req.results) {
            VNRecognizedText *top = [[obs topCandidates:1] firstObject];
            if (!top) continue;
            NSMutableDictionary *entry = [NSMutableDictionary dictionary];
            entry[@"text"] = top.string ?: @"";
            entry[@"confidence"] = @(top.confidence);
            // Vision returns normalized [0,1] frames in the lower-left
            // origin of the source image. Convert to pixel coordinates
            // in top-left origin for consistency with the rest of the
            // desktop control API.
            CGRect nrect = obs.boundingBox;
            entry[@"frame"] = @{
              @"x" : @(nrect.origin.x),
              @"y" : @(1.0 - nrect.origin.y - nrect.size.height),
              @"width" : @(nrect.size.width),
              @"height" : @(nrect.size.height),
            };
            [results addObject:entry];
          }
        }];
    request.recognitionLanguages = languages;
    request.recognitionLevel = fastMode
                                   ? VNRequestTextRecognitionLevelFast
                                   : VNRequestTextRecognitionLevelAccurate;
    request.usesLanguageCorrection = !fastMode;

    VNImageRequestHandler *handler =
        [[VNImageRequestHandler alloc] initWithCGImage:cgImage options:@{}];
    NSError *performErr = nil;
    [handler performRequests:@[ request ] error:&performErr];
    CGImageRelease(cgImage);
    if (performErr) {
      std::string msg = [performErr.localizedDescription UTF8String] ?: "";
      Napi::Error::New(env, ("Vision performRequests failed: " + msg).c_str())
          .ThrowAsJavaScriptException();
      return env.Null();
    }
    if (resultErr) {
      std::string msg = [resultErr.localizedDescription UTF8String] ?: "";
      Napi::Error::New(env, ("Vision request failed: " + msg).c_str())
          .ThrowAsJavaScriptException();
      return env.Null();
    }
  }

  Napi::Array out = Napi::Array::New(env);
  for (NSUInteger i = 0; i < [results count]; i++) {
    NSDictionary *e = results[i];
    Napi::Object obj = Napi::Object::New(env);
    NSString *t = e[@"text"];
    obj.Set("text", Napi::String::New(env, [t UTF8String] ?: ""));
    obj.Set("confidence", Napi::Number::New(env, [e[@"confidence"] doubleValue]));
    NSDictionary *f = e[@"frame"];
    Napi::Object frame = Napi::Object::New(env);
    frame.Set("x", Napi::Number::New(env, [f[@"x"] doubleValue]));
    frame.Set("y", Napi::Number::New(env, [f[@"y"] doubleValue]));
    frame.Set("width", Napi::Number::New(env, [f[@"width"] doubleValue]));
    frame.Set("height", Napi::Number::New(env, [f[@"height"] doubleValue]));
    obj.Set("frame", frame);
    out.Set((uint32_t)i, obj);
  }
  return out;
}

// ─── Text-to-Speech (AVSpeechSynthesizer) ────────────────────────────
//
// Fire-and-forget synthesis. We keep one shared synthesizer so calls
// cancel the previous utterance if `interrupt` is true (default).
// Non-blocking — returns immediately.

static AVSpeechSynthesizer *gSynthesizer = nil;

static Napi::Value Speak(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "speak(text, options?) requires a string")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string text = info[0].As<Napi::String>().Utf8Value();
  NSString *nsText = NSFromStd(text);

  NSString *language = @"en-US";
  float rate = AVSpeechUtteranceDefaultSpeechRate;
  bool interrupt = true;
  if (info.Length() > 1 && info[1].IsObject()) {
    Napi::Object opts = info[1].As<Napi::Object>();
    if (opts.Has("language")) {
      language = NSFromStd(opts.Get("language").As<Napi::String>().Utf8Value());
    }
    if (opts.Has("rate")) {
      rate = (float)opts.Get("rate").As<Napi::Number>().FloatValue();
    }
    if (opts.Has("interrupt")) {
      interrupt = opts.Get("interrupt").ToBoolean().Value();
    }
  }

  @autoreleasepool {
    if (!gSynthesizer) {
      gSynthesizer = [[AVSpeechSynthesizer alloc] init];
    }
    if (interrupt && gSynthesizer.isSpeaking) {
      [gSynthesizer stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
    }
    AVSpeechUtterance *utterance = [[AVSpeechUtterance alloc] initWithString:nsText];
    utterance.voice = [AVSpeechSynthesisVoice voiceWithLanguage:language];
    utterance.rate = rate;
    [gSynthesizer speakUtterance:utterance];
  }
  return env.Undefined();
}

static Napi::Value StopSpeaking(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (gSynthesizer && gSynthesizer.isSpeaking) {
    [gSynthesizer stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
  }
  return env.Undefined();
}

// ─── Speech-to-Text (SFSpeechRecognizer) ─────────────────────────────
//
// Three-step API:
//   1. sttRequestAuth()        — async system prompt, returns status
//   2. sttStartRecording(...)  — starts AVAudioEngine writing to tmp .caf
//   3. sttStopAndTranscribe(lang) — stops, runs SFSpeechRecognizer on
//      the file, returns the transcript (blocking up to 30s)
//
// We do the recognition in a blocking fashion via dispatch_semaphore
// because SFSpeechRecognizer's result handler is async. This is fine
// for a one-shot "push to talk" button — the user already committed
// by pressing stop — but means the main JS thread is blocked for the
// duration of the transcription. Typical latency: 500 ms for a 5-second
// clip.

static AVAudioEngine *gAudioEngine = nil;
static AVAudioFile *gAudioFile = nil;
static NSString *gAudioPath = nil;

static Napi::Value SttRequestAuth(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  __block SFSpeechRecognizerAuthorizationStatus status =
      SFSpeechRecognizerAuthorizationStatusNotDetermined;
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus s) {
    status = s;
    dispatch_semaphore_signal(sem);
  }];
  // Give the system 5 s to show the prompt + respond; if the user is
  // afk we return notDetermined and the caller can retry later.
  dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC);
  dispatch_semaphore_wait(sem, timeout);

  const char *str = "notDetermined";
  switch (status) {
    case SFSpeechRecognizerAuthorizationStatusAuthorized: str = "authorized"; break;
    case SFSpeechRecognizerAuthorizationStatusDenied: str = "denied"; break;
    case SFSpeechRecognizerAuthorizationStatusRestricted: str = "restricted"; break;
    default: break;
  }
  return Napi::String::New(env, str);
}

static Napi::Value SttStartRecording(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  @autoreleasepool {
    if (gAudioEngine && gAudioEngine.isRunning) {
      [gAudioEngine stop];
      [gAudioEngine.inputNode removeTapOnBus:0];
      gAudioEngine = nil;
      gAudioFile = nil;
    }

    NSString *tmpDir = NSTemporaryDirectory();
    NSString *name = [NSString stringWithFormat:@"noobclaw_stt_%.0f.caf", [[NSDate date] timeIntervalSince1970] * 1000];
    NSString *path = [tmpDir stringByAppendingPathComponent:name];
    gAudioPath = path;

    gAudioEngine = [[AVAudioEngine alloc] init];
    AVAudioInputNode *input = gAudioEngine.inputNode;
    AVAudioFormat *format = [input outputFormatForBus:0];

    NSError *err = nil;
    gAudioFile = [[AVAudioFile alloc] initForWriting:[NSURL fileURLWithPath:path]
                                            settings:format.settings
                                               error:&err];
    if (err) {
      std::string msg = [err.localizedDescription UTF8String] ?: "";
      Napi::Error::New(env, ("AVAudioFile initForWriting failed: " + msg).c_str())
          .ThrowAsJavaScriptException();
      gAudioEngine = nil;
      gAudioFile = nil;
      return env.Null();
    }

    [input installTapOnBus:0
                bufferSize:1024
                    format:format
                     block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
                       NSError *writeErr = nil;
                       [gAudioFile writeFromBuffer:buffer error:&writeErr];
                     }];

    [gAudioEngine prepare];
    NSError *startErr = nil;
    [gAudioEngine startAndReturnError:&startErr];
    if (startErr) {
      std::string msg = [startErr.localizedDescription UTF8String] ?: "";
      [input removeTapOnBus:0];
      gAudioEngine = nil;
      gAudioFile = nil;
      Napi::Error::New(env, ("AVAudioEngine start failed: " + msg).c_str())
          .ThrowAsJavaScriptException();
      return env.Null();
    }
  }
  return Napi::String::New(env, [gAudioPath UTF8String] ?: "");
}

static Napi::Value SttStopAndTranscribe(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  NSString *locale = @"en-US";
  if (info.Length() > 0 && info[0].IsString()) {
    locale = NSFromStd(info[0].As<Napi::String>().Utf8Value());
  }

  NSString *path = nil;
  @autoreleasepool {
    if (!gAudioEngine || !gAudioPath) {
      Napi::Error::New(env, "sttStopAndTranscribe called without prior sttStartRecording")
          .ThrowAsJavaScriptException();
      return env.Null();
    }
    [gAudioEngine stop];
    [gAudioEngine.inputNode removeTapOnBus:0];
    gAudioEngine = nil;
    gAudioFile = nil;  // AVAudioFile flushes on dealloc
    path = gAudioPath;
    gAudioPath = nil;
  }

  __block NSString *transcript = nil;
  __block NSError *recogErr = nil;
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);

  @autoreleasepool {
    SFSpeechRecognizer *recognizer =
        [[SFSpeechRecognizer alloc] initWithLocale:[NSLocale localeWithLocaleIdentifier:locale]];
    if (!recognizer || !recognizer.isAvailable) {
      Napi::Error::New(env, "SFSpeechRecognizer unavailable for locale")
          .ThrowAsJavaScriptException();
      return env.Null();
    }

    NSURL *url = [NSURL fileURLWithPath:path];
    SFSpeechURLRecognitionRequest *request =
        [[SFSpeechURLRecognitionRequest alloc] initWithURL:url];
    request.shouldReportPartialResults = NO;
    // Prefer on-device recognition when available for privacy + no
    // network round-trip. Falls back to server if the model isn't
    // installed.
    if (@available(macOS 10.15, *)) {
      request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition;
    }

    [recognizer
        recognitionTaskWithRequest:request
                     resultHandler:^(SFSpeechRecognitionResult *r, NSError *e) {
                       if (e) {
                         recogErr = e;
                         dispatch_semaphore_signal(sem);
                         return;
                       }
                       if (r.isFinal) {
                         transcript = r.bestTranscription.formattedString;
                         dispatch_semaphore_signal(sem);
                       }
                     }];

    // Cap the block at 30 s — plenty for a push-to-talk clip.
    dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC);
    dispatch_semaphore_wait(sem, timeout);
  }

  // Tidy the temp file regardless of outcome.
  if (path) {
    [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
  }

  if (recogErr) {
    std::string msg = [recogErr.localizedDescription UTF8String] ?: "";
    Napi::Error::New(env, ("SFSpeechRecognizer failed: " + msg).c_str())
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::String::New(env, transcript ? ([transcript UTF8String] ?: "") : "");
}

// ─── Quick Look thumbnails (QLThumbnailGenerator) ────────────────────
//
// Generate a thumbnail for any file macOS knows how to preview:
// PDFs, images, videos, docx, pptx, etc. Returns PNG bytes so the
// renderer can drop them straight into <img src="data:image/png;base64,...">.
// Synchronous wrapper around QLThumbnailGenerator's async API via
// dispatch_semaphore.

static Napi::Value QuickLookThumbnail(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "quickLookThumbnail(filePath, options?) requires a string")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string pathStr = info[0].As<Napi::String>().Utf8Value();

  double maxSize = 512.0;
  double scale = 2.0;
  if (info.Length() > 1 && info[1].IsObject()) {
    Napi::Object opts = info[1].As<Napi::Object>();
    if (opts.Has("maxSize")) maxSize = opts.Get("maxSize").As<Napi::Number>().DoubleValue();
    if (opts.Has("scale")) scale = opts.Get("scale").As<Napi::Number>().DoubleValue();
  }

  __block NSData *pngData = nil;
  __block NSError *thumbErr = nil;
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);

  @autoreleasepool {
    NSString *nsPath = NSFromStd(pathStr);
    NSURL *url = [NSURL fileURLWithPath:nsPath];
    CGSize size = CGSizeMake(maxSize, maxSize);
    QLThumbnailGenerationRequest *req =
        [[QLThumbnailGenerationRequest alloc] initWithFileAtURL:url
                                                            size:size
                                                           scale:scale
                                              representationTypes:QLThumbnailGenerationRequestRepresentationTypeAll];
    [[QLThumbnailGenerator sharedGenerator]
        generateBestRepresentationForRequest:req
                          completionHandler:^(QLThumbnailRepresentation *rep, NSError *e) {
                            if (e || !rep) {
                              thumbErr = e;
                              dispatch_semaphore_signal(sem);
                              return;
                            }
                            // Convert NSImage → PNG bytes.
                            NSImage *image = rep.NSImage;
                            CGImageRef cgImage =
                                [image CGImageForProposedRect:NULL context:nil hints:nil];
                            if (!cgImage) {
                              dispatch_semaphore_signal(sem);
                              return;
                            }
                            NSBitmapImageRep *bmp =
                                [[NSBitmapImageRep alloc] initWithCGImage:cgImage];
                            pngData = [bmp representationUsingType:NSBitmapImageFileTypePNG
                                                        properties:@{}];
                            dispatch_semaphore_signal(sem);
                          }];

    dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC);
    dispatch_semaphore_wait(sem, timeout);
  }

  if (thumbErr) {
    std::string msg = [thumbErr.localizedDescription UTF8String] ?: "";
    Napi::Error::New(env, ("QLThumbnailGenerator failed: " + msg).c_str())
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  if (!pngData) return env.Null();

  return Napi::Buffer<uint8_t>::Copy(env, (const uint8_t *)pngData.bytes, pngData.length);
}

// ─── Natural Language framework ──────────────────────────────────────
//
// Three useful things we get essentially for free on macOS 10.14+:
//   1. Language detection (NLLanguageRecognizer)
//   2. Tokenization (NLTokenizer)
//   3. Sentence embeddings (NLEmbedding) — 300-d float vectors for
//      local semantic search over chat history, no API call
//
// Language codes follow BCP-47 (zh-Hans, en, ja, ...).

static Napi::Value DetectLanguage(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "detectLanguage(text) requires a string")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  @autoreleasepool {
    NSString *text = NSFromStd(info[0].As<Napi::String>().Utf8Value());
    NLLanguageRecognizer *rec = [[NLLanguageRecognizer alloc] init];
    [rec processString:text];
    NLLanguage lang = rec.dominantLanguage;
    if (!lang) return env.Null();
    return Napi::String::New(env, [lang UTF8String] ?: "");
  }
}

static Napi::Value Tokenize(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "tokenize(text, unit?) requires a string")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string unit = "word";
  if (info.Length() > 1 && info[1].IsString()) {
    unit = info[1].As<Napi::String>().Utf8Value();
  }

  NLTokenUnit tokenUnit = NLTokenUnitWord;
  if (unit == "sentence") tokenUnit = NLTokenUnitSentence;
  else if (unit == "paragraph") tokenUnit = NLTokenUnitParagraph;

  Napi::Array out = Napi::Array::New(env);
  @autoreleasepool {
    NSString *text = NSFromStd(info[0].As<Napi::String>().Utf8Value());
    NLTokenizer *tokenizer = [[NLTokenizer alloc] initWithUnit:tokenUnit];
    tokenizer.string = text;
    __block uint32_t idx = 0;
    [tokenizer
        enumerateTokensInRange:NSMakeRange(0, [text length])
                    usingBlock:^(NSRange tokenRange, NLTokenizerAttributes, BOOL *stop) {
                      NSString *piece = [text substringWithRange:tokenRange];
                      // Can't use out directly inside the block in a
                      // type-safe way — collect via ivar.
                      Napi::HandleScope scope(env);
                      out.Set(idx++, Napi::String::New(env, [piece UTF8String] ?: ""));
                    }];
  }
  return out;
}

static Napi::Value SentenceEmbedding(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "sentenceEmbedding(text, language?) requires a string")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  NLLanguage language = NLLanguageEnglish;
  if (info.Length() > 1 && info[1].IsString()) {
    language = NSFromStd(info[1].As<Napi::String>().Utf8Value());
  }
  @autoreleasepool {
    NSString *text = NSFromStd(info[0].As<Napi::String>().Utf8Value());
    NLEmbedding *embedding = [NLEmbedding sentenceEmbeddingForLanguage:language];
    if (!embedding) return env.Null();
    NSArray<NSNumber *> *vector = [embedding vectorForString:text];
    if (!vector || [vector count] == 0) return env.Null();
    Napi::Float64Array arr = Napi::Float64Array::New(env, [vector count]);
    for (NSUInteger i = 0; i < [vector count]; i++) {
      arr[i] = [vector[i] doubleValue];
    }
    return arr;
  }
}

// ─── Sleep / Wake notification listener ──────────────────────────────
//
// Subscribes to NSWorkspace.willSleepNotification / didWakeNotification
// and forwards them to a JS callback registered via onPowerEvent.
// Used by the sidecar to pause long-running AI tasks before sleep and
// resume them on wake, so we don't have a half-streamed LLM response
// sitting in a dead TCP connection.
//
// Implementation detail: the Node-addon-api ThreadSafeFunction machinery
// is the "correct" way to dispatch into JS from a non-JS thread, but
// NSWorkspace observer blocks always run on the main thread. Since the
// sidecar's V8 thread IS main on macOS, we can call the JS callback
// directly — no TSFN needed.

static Napi::FunctionReference gPowerCallback;
static id gSleepObserver = nil;
static id gWakeObserver = nil;

static void powerFire(const char *kind) {
  if (gPowerCallback.IsEmpty()) return;
  Napi::Env env = gPowerCallback.Env();
  Napi::HandleScope scope(env);
  gPowerCallback.Call({Napi::String::New(env, kind)});
}

static Napi::Value OnPowerEvent(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "onPowerEvent(callback) requires a function")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  gPowerCallback = Napi::Persistent(info[0].As<Napi::Function>());

  NSNotificationCenter *center = [[NSWorkspace sharedWorkspace] notificationCenter];
  if (gSleepObserver) {
    [center removeObserver:gSleepObserver];
    gSleepObserver = nil;
  }
  if (gWakeObserver) {
    [center removeObserver:gWakeObserver];
    gWakeObserver = nil;
  }
  gSleepObserver = [center addObserverForName:NSWorkspaceWillSleepNotification
                                       object:nil
                                        queue:[NSOperationQueue mainQueue]
                                   usingBlock:^(NSNotification *note) {
                                     powerFire("willSleep");
                                   }];
  gWakeObserver = [center addObserverForName:NSWorkspaceDidWakeNotification
                                      object:nil
                                       queue:[NSOperationQueue mainQueue]
                                  usingBlock:^(NSNotification *note) {
                                    powerFire("didWake");
                                  }];
  return env.Undefined();
}

// ─── Touch ID / Face ID (LAContext) ──────────────────────────────────
//
// Synchronous wrapper around LAContext.evaluatePolicy. The underlying
// API is async, but like STT we block on a semaphore because this is
// invoked from user-initiated UI ("unlock NoobClaw with biometrics")
// and we don't want to juggle callback plumbing.
//
// Returns:
//   "ok"           — authenticated successfully
//   "denied"       — user cancelled / failed
//   "unavailable"  — no biometric hardware or not enrolled

static Napi::Value BiometricAuth(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  NSString *reason = @"Authenticate to access NoobClaw";
  if (info.Length() > 0 && info[0].IsString()) {
    reason = NSFromStd(info[0].As<Napi::String>().Utf8Value());
  }

  __block const char *resultStr = "denied";
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);

  @autoreleasepool {
    LAContext *ctx = [[LAContext alloc] init];
    NSError *availErr = nil;
    if (![ctx canEvaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics
                          error:&availErr]) {
      return Napi::String::New(env, "unavailable");
    }

    [ctx evaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics
        localizedReason:reason
                  reply:^(BOOL success, NSError *error) {
                    resultStr = success ? "ok" : "denied";
                    dispatch_semaphore_signal(sem);
                  }];

    // Cap at 60 s so a user who walked away doesn't wedge the thread.
    dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC);
    dispatch_semaphore_wait(sem, timeout);
  }

  return Napi::String::New(env, resultStr);
}

// ─── Module init ──────────────────────────────────────────────────────

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("screenshot", Napi::Function::New(env, Screenshot));
  exports.Set("mouseMove", Napi::Function::New(env, MouseMove));
  exports.Set("mouseClick", Napi::Function::New(env, MouseClick));
  exports.Set("mouseDrag", Napi::Function::New(env, MouseDrag));
  exports.Set("keyType", Napi::Function::New(env, KeyType));
  exports.Set("keyPress", Napi::Function::New(env, KeyPress));
  exports.Set("clipboardGet", Napi::Function::New(env, ClipboardGet));
  exports.Set("clipboardSet", Napi::Function::New(env, ClipboardSet));
  exports.Set("clipboardVerify", Napi::Function::New(env, ClipboardVerify));
  exports.Set("getActiveWindow", Napi::Function::New(env, GetActiveWindow));
  exports.Set("listWindows", Napi::Function::New(env, ListWindows));
  exports.Set("isAccessibilityTrusted",
              Napi::Function::New(env, IsAccessibilityTrusted));
  exports.Set("getAxTree", Napi::Function::New(env, GetAxTree));
  exports.Set("keychainSet", Napi::Function::New(env, KeychainSet));
  exports.Set("keychainGet", Napi::Function::New(env, KeychainGet));
  exports.Set("keychainDelete", Napi::Function::New(env, KeychainDelete));
  exports.Set("recognizeText", Napi::Function::New(env, RecognizeText));
  exports.Set("speak", Napi::Function::New(env, Speak));
  exports.Set("stopSpeaking", Napi::Function::New(env, StopSpeaking));
  exports.Set("sttRequestAuth", Napi::Function::New(env, SttRequestAuth));
  exports.Set("sttStartRecording", Napi::Function::New(env, SttStartRecording));
  exports.Set("sttStopAndTranscribe", Napi::Function::New(env, SttStopAndTranscribe));
  exports.Set("quickLookThumbnail", Napi::Function::New(env, QuickLookThumbnail));
  exports.Set("detectLanguage", Napi::Function::New(env, DetectLanguage));
  exports.Set("tokenize", Napi::Function::New(env, Tokenize));
  exports.Set("sentenceEmbedding", Napi::Function::New(env, SentenceEmbedding));
  exports.Set("onPowerEvent", Napi::Function::New(env, OnPowerEvent));
  exports.Set("biometricAuth", Napi::Function::New(env, BiometricAuth));
  return exports;
}

NODE_API_MODULE(noobclaw_desktop, Init)
