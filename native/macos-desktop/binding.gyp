{
  "targets": [
    {
      "target_name": "noobclaw_desktop",
      "conditions": [
        ["OS=='mac'", {
          "sources": [
            "src/noobclaw_desktop.mm"
          ],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")"
          ],
          "defines": [
            "NAPI_DISABLE_CPP_EXCEPTIONS",
            "NAPI_VERSION=8"
          ],
          "cflags!": ["-fno-exceptions"],
          "cflags_cc!": ["-fno-exceptions"],
          "libraries": [
            "-framework AppKit",
            "-framework Cocoa",
            "-framework CoreGraphics",
            "-framework ApplicationServices",
            "-framework ImageIO",
            "-framework CoreFoundation",
            "-framework CoreServices",
            "-framework Security",
            "-framework Carbon",
            "-framework Vision",
            "-framework AVFoundation",
            "-framework Speech",
            "-framework QuickLookThumbnailing",
            "-framework NaturalLanguage",
            "-framework LocalAuthentication"
          ],
          "xcode_settings": {
            "MACOSX_DEPLOYMENT_TARGET": "10.15",
            "OTHER_CFLAGS": ["-ObjC++", "-Wno-deprecated-declarations"],
            "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-stdlib=libc++"],
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "GCC_ENABLE_CPP_EXCEPTIONS": "NO"
          }
        }],
        ["OS!='mac'", {
          "type": "none"
        }]
      ]
    }
  ]
}
