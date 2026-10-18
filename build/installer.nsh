!macro customInstall
  WriteRegStr HKCU "Software\Classes\liber.net" "" "liber.net document"
  WriteRegStr HKCU "Software\Classes\liber.net" "FriendlyTypeName" "liber.net document"
  WriteRegStr HKCU "Software\Classes\liber.net\DefaultIcon" "" "$INSTDIR\liber.net.exe,0"
  WriteRegStr HKCU "Software\Classes\liber.net\shell\open\command" "" '"$INSTDIR\liber.net.exe" "%1"'

  WriteRegStr HKCU "Software\Clients\StartMenuInternet\liber.net" "" "liber.net"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\liber.net\DefaultIcon" "" "$INSTDIR\liber.net.exe,0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\liber.net\shell\open\command" "" '"$INSTDIR\liber.net.exe" "%1"'
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\liber.net\Capabilities" "ApplicationName" "liber.net"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\liber.net\Capabilities" "ApplicationDescription" "liber.net browser"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\liber.net\Capabilities" "ApplicationIcon" "$INSTDIR\liber.net.exe,0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\liber.net\Capabilities\URLAssociations" "http" "liber.net"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\liber.net\Capabilities\URLAssociations" "https" "liber.net"
  WriteRegStr HKCU "Software\RegisteredApplications" "liber.net" "Software\Clients\StartMenuInternet\liber.net\Capabilities"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\liber.net"
  DeleteRegKey HKCU "Software\Classes\liber.net"
  DeleteRegValue HKCU "Software\RegisteredApplications" "liber.net"
!macroend
