package main

// Service states and start types as the Service Control Manager numbers them
// (winsvc.h), named the way the inventory has always shown them.

func inventoryServiceState(state uint32) string {
	switch state {
	case 1:
		return "stopped"
	case 2:
		return "start pending"
	case 3:
		return "stop pending"
	case 4:
		return "running"
	case 5:
		return "continue pending"
	case 6:
		return "pause pending"
	case 7:
		return "paused"
	default:
		return "unknown"
	}
}

func inventoryServiceStartType(startType uint32) string {
	switch startType {
	case 0:
		return "boot"
	case 1:
		return "system"
	case 2:
		return "automatic"
	case 3:
		return "manual"
	case 4:
		return "disabled"
	default:
		return ""
	}
}
