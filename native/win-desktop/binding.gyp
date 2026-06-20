{
  "targets": [
    {
      "target_name": "noobclaw_desktop_win",
      "conditions": [
        ["OS=='win'", {
          "sources": [
            "src/noobclaw_desktop_win.cc"
          ],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")"
          ],
          "defines": [
            "NAPI_DISABLE_CPP_EXCEPTIONS",
            "NAPI_VERSION=8",
            "NOMINMAX",
            "WIN32_LEAN_AND_MEAN"
          ],
          "libraries": [
            "-luser32.lib",
            "-lgdi32.lib",
            "-lgdiplus.lib",
            "-lkernel32.lib",
            "-lshcore.lib",
            "-lpowrprof.lib"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 0,
              "AdditionalOptions": ["/std:c++17"]
            }
          }
        }],
        ["OS!='win'", {
          "type": "none"
        }]
      ]
    }
  ]
}
