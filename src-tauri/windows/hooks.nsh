!include "LogicLib.nsh"
!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Preparing Ollama and the local AI models. An internet connection is required."
  ; A Node runtime is inside this binary. End users do not install Node.js or npm.
  ; Use a per-user installer so Ollama, model downloads and local data belong to the right user.
  nsExec::ExecToLog '"$INSTDIR\clean-folder-worker.exe" --bootstrap'
  Pop $0
  ${If} $0 != 0
    DetailPrint "AI setup did not finish. Clean_folder can resume it on first launch."
    MessageBox MB_OK|MB_ICONEXCLAMATION "Clean_folder is installed, but AI setup could not finish. Open Clean_folder and choose Retry setup. Your files have not been moved."
  ${Else}
    DetailPrint "Ollama and both default models are ready."
  ${EndIf}
!macroend
; Ollama and its downloaded models may be shared with other applications.
; Uninstalling Clean_folder therefore does not remove them or the local history.
