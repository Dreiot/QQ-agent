!include LogicLib.nsh

; Runtime data and administrator extensions keep their existing locations. The
; helper is embedded in both executables; it is not a runtime dependency.
Var QQAgentPreservationExitCode
!ifndef BUILD_UNINSTALLER
Var QQAgentOldInstallDir
Var QQAgentAdditionalOldInstallDir
Var QQAgentBackupRoot
Var QQAgentBackupReceipt
Var QQAgentBackupPath
Var QQAgentTargetInstallDir
Var QQAgentOldUninstallString
!endif

!macro QQAgentExtractPreservationHelper
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=qq-agent-preserve-user-data.ps1 "${BUILD_RESOURCES_DIR}\preserve-user-data.ps1"
!macroend

!ifndef BUILD_UNINSTALLER
Function QQAgentPreparePreservation
  !insertmacro QQAgentExtractPreservationHelper
  ${If} $QQAgentBackupRoot == ""
    StrCpy $QQAgentBackupRoot "$LOCALAPPDATA\QQ Agent\install-backups"
  ${EndIf}
  ${If} $QQAgentBackupReceipt == ""
    StrCpy $QQAgentBackupReceipt "$PLUGINSDIR\qq-agent-preservation.ini"
  ${EndIf}
  StrCpy $QQAgentBackupPath ""
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\qq-agent-preserve-user-data.ps1" -Mode Prepare -InstallRoot "$INSTDIR" -OldRoot "$QQAgentOldInstallDir" -AdditionalOldRoot "$QQAgentAdditionalOldInstallDir" -BackupBase "$QQAgentBackupRoot" -Receipt "$QQAgentBackupReceipt"'
  Pop $QQAgentPreservationExitCode
  ${If} $QQAgentPreservationExitCode != "0"
    DetailPrint "User data preparation failed ($QQAgentPreservationExitCode). No old installation was removed. Backups: $QQAgentBackupRoot"
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP|MB_OK "QQ Agent could not safely preserve user data. Installation stopped before removing the old version.$\r$\nClose running accounts, check available disk space and file permissions, then retry.$\r$\nExisting backups remain in:$\r$\n$QQAgentBackupRoot"
    ${EndIf}
    SetErrorLevel 2
    Abort
  ${EndIf}
  ClearErrors
  ReadINIStr $QQAgentBackupPath "$QQAgentBackupReceipt" "Preservation" "BackupPath"
  ${If} ${Errors}
  ${OrIf} $QQAgentBackupPath == ""
    DetailPrint "User data preparation did not produce a recovery receipt. No old installation was removed."
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP|MB_OK "QQ Agent could not verify the user data recovery receipt. Installation stopped before removing the old version.$\r$\nExisting backups remain in:$\r$\n$QQAgentBackupRoot"
    ${EndIf}
    SetErrorLevel 2
    Abort
  ${EndIf}
FunctionEnd

Function QQAgentRestorePreservation
  !insertmacro QQAgentExtractPreservationHelper
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\qq-agent-preserve-user-data.ps1" -Mode Restore -InstallRoot "$INSTDIR" -Receipt "$QQAgentBackupReceipt"'
  Pop $QQAgentPreservationExitCode
  ${If} $QQAgentPreservationExitCode != "0"
    DetailPrint "User data restore failed ($QQAgentPreservationExitCode). Recovery backup retained: $QQAgentBackupPath"
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP|MB_OK "QQ Agent could not restore all user data. Installation stopped and will not launch the app.$\r$\nDo not delete this recovery backup:$\r$\n$QQAgentBackupPath"
    ${EndIf}
    SetErrorLevel 2
    Abort
  ${EndIf}
FunctionEnd
!else
Function un.QQAgentRemoveProgramFiles
  !insertmacro QQAgentExtractPreservationHelper
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\qq-agent-preserve-user-data.ps1" -Mode Remove -InstallRoot "$INSTDIR"'
  Pop $QQAgentPreservationExitCode
  ${If} $QQAgentPreservationExitCode != "0"
    DetailPrint "Program cleanup failed ($QQAgentPreservationExitCode). User data and extensions were retained."
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP|MB_OK "QQ Agent could not remove all program files. User data and extensions were retained.$\r$\nClose running accounts, check file permissions, then retry."
    ${EndIf}
    SetErrorLevel 2
    Abort
  ${EndIf}
FunctionEnd
!endif

; Keep the same legacy registry fallback used by uninstallOldVersion. Its helper
; functions are defined by the template before the compiled installer is linked.
!macro QQAgentResolveOldInstallRoot ROOT_KEY OUTPUT
  ReadRegStr ${OUTPUT} ${ROOT_KEY} "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} ${OUTPUT} == ""
    ReadRegStr $QQAgentOldUninstallString ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ${If} $QQAgentOldUninstallString == ""
        ReadRegStr $QQAgentOldUninstallString ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY_2}" "UninstallString"
      ${EndIf}
    !endif
    ${If} $QQAgentOldUninstallString != ""
      Push "$QQAgentOldUninstallString"
      Call GetInQuotes
      Pop ${OUTPUT}
      ${If} ${OUTPUT} != ""
        Push ${OUTPUT}
        Call GetFileParent
        Pop ${OUTPUT}
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro customHeader
!ifndef BUILD_UNINSTALLER
; This include is expanded after the upstream running-check macro exists.
!include "${BUILD_RESOURCES_DIR}\check-app-running.nsh"

; Unlike customInit, this runs only after the final directory/mode selection,
; in silent installations too, before the template invokes any old uninstaller.
Section "-QQAgentPreserveUserData"
  SectionIn RO
  ; Match the template's silent per-machine elevation before capturing paths.
  ; Otherwise its later main section could switch roots after our snapshot.
  !ifndef INSTALL_MODE_PER_ALL_USERS
    !ifndef ONE_CLICK
      ${If} $hasPerMachineInstallation == "1"
      ${AndIf} ${Silent}
        ${IfNot} ${UAC_IsAdmin}
          ShowWindow $HWNDPARENT ${SW_HIDE}
          !insertmacro UAC_RunElevated
          ${Switch} $0
            ${Case} 0
              ${Break}
            ${Case} 1223
              ${Break}
            ${Default}
              MessageBox MB_ICONSTOP|MB_OK "Unable to elevate, error $0"
              ${Break}
          ${EndSwitch}
          Quit
        ${Else}
          !insertmacro setInstallModePerAllUsers
        ${EndIf}
      ${EndIf}
    !endif
  !endif
  StrCpy $QQAgentTargetInstallDir "$INSTDIR"
  StrCpy $QQAgentOldInstallDir ""
  StrCpy $QQAgentAdditionalOldInstallDir ""
  !insertmacro QQAgentResolveOldInstallRoot SHELL_CONTEXT $QQAgentOldInstallDir
  ${If} $installMode == "all"
    ; The template also removes a current-user installation in all-users mode.
    !insertmacro QQAgentResolveOldInstallRoot HKCU $QQAgentAdditionalOldInstallDir
  ${EndIf}

  ${If} $QQAgentOldInstallDir != ""
    StrCpy $INSTDIR "$QQAgentOldInstallDir"
    Call QQAgentCheckInstallRunning
  ${EndIf}
  ${If} $QQAgentAdditionalOldInstallDir != ""
  ${AndIf} $QQAgentAdditionalOldInstallDir != $QQAgentOldInstallDir
    StrCpy $INSTDIR "$QQAgentAdditionalOldInstallDir"
    Call QQAgentCheckInstallRunning
  ${EndIf}
  StrCpy $INSTDIR "$QQAgentTargetInstallDir"
  Call QQAgentCheckInstallRunning
  Call QQAgentPreparePreservation
SectionEnd
!endif
!macroend

!macro customInstall
!ifndef BUILD_UNINSTALLER
  Call QQAgentRestorePreservation
!endif
!macroend

!macro customRemoveFiles
!ifdef BUILD_UNINSTALLER
  Call un.QQAgentRemoveProgramFiles
!endif
!macroend
