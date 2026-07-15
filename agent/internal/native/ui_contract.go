package native

import (
	"strings"
	"unicode/utf16"
)

const remoteSupportUILaunchTaskName = "TECHI Remote Support Recovery UI Launch"

func remoteSupportMainWindowSizeUsable(width, height int32) bool {
	return width >= 200 && height >= 120
}

func remoteSupportUITaskXML(exe string) string {
	return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Principals>
    <Principal id="Author">
      <GroupId>S-1-5-32-545</GroupId>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>` + xmlEscapeRemoteSupport(exe) + `</Command>
    </Exec>
  </Actions>
</Task>
`
}

func xmlEscapeRemoteSupport(value string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&apos;").Replace(value)
}

func encodeUTF16LEWithBOMRemoteSupport(value string) []byte {
	units := utf16.Encode([]rune(value))
	out := make([]byte, 2+len(units)*2)
	out[0], out[1] = 0xff, 0xfe
	for i, unit := range units {
		out[2+i*2] = byte(unit)
		out[3+i*2] = byte(unit >> 8)
	}
	return out
}
