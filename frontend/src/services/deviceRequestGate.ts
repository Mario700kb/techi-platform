export interface DeviceRequestToken {
  deviceId: number;
  generation: number;
}

export class DeviceRequestGate {
  private generation = 0;
  private activeDeviceId: number | null = null;

  activate(deviceId: number): void {
    this.activeDeviceId = deviceId;
    this.generation += 1;
  }

  begin(deviceId: number): DeviceRequestToken {
    this.activeDeviceId = deviceId;
    this.generation += 1;
    return { deviceId, generation: this.generation };
  }

  invalidate(): void {
    this.activeDeviceId = null;
    this.generation += 1;
  }

  isCurrent(token: DeviceRequestToken): boolean {
    return token.deviceId === this.activeDeviceId && token.generation === this.generation;
  }
}
