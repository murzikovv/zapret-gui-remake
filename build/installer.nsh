!macro customInit
  nsExec::ExecToStack 'taskkill /F /IM "Zapret GUI.exe"'
  nsExec::ExecToStack 'taskkill /F /IM "zapret-gui-remake.exe"'
!macroend
