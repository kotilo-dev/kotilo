; NSIS hooks for the Tauri installer (bundle.windows.nsis.installerHooks).
;
; The hub sidecar (<mainBinaryName>-hub.exe, mainBinaryName = brand.json exePrefix) runs next to
; the app and holds its exe and native DLLs open. It exits on its own once the app is gone (it
; watches the parent pid), but an update starts the installer right after the app exits, and the
; app's supervisor restarts a hub that is killed while the app still runs. So: close the app the
; way Tauri does (its own macro, which asks the user unless the install is silent), then wait up
; to 5 s for the hub to exit and stop it if it is still running. Only the hub inside $INSTDIR is
; touched, never a hub started from somewhere else (e.g. a dev build).

!macro AGENTHUB_STOP_HUB
  !ifmacrodef CheckIfAppIsRunning
    !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  !endif
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$p = Get-Process -Name '${MAINBINARYNAME}-hub' -ErrorAction SilentlyContinue | Where-Object { $$_.Path -eq '$INSTDIR\${MAINBINARYNAME}-hub.exe' }; if ($$p) { $$p | Wait-Process -Timeout 5 -ErrorAction SilentlyContinue; $$p | Stop-Process -Force -ErrorAction SilentlyContinue }"`
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro AGENTHUB_STOP_HUB
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro AGENTHUB_STOP_HUB
!macroend
