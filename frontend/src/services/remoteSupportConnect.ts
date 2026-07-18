import {
  getConnectUrl,
  type ConnectUrlResponse,
} from "../api/remoteSupport";
import { buildRustDeskFallbackUrlFromTechiUrl, launchConnect } from "./rustdeskLaunch";

type ConnectUrlFactory = (deviceId: number) => Promise<ConnectUrlResponse>;
type ProtocolLauncher = (techiUrl: string, rustdeskUrl: string, onFallback?: () => void) => void;

export class RemoteSupportLaunchCoordinator {
  private generation = 0;

  invalidate(): void {
    this.generation += 1;
  }

  async launch(
    deviceId: number,
    getUrl: ConnectUrlFactory = getConnectUrl,
    openProtocol: ProtocolLauncher = launchConnect,
    onFallback?: () => void,
  ): Promise<boolean> {
    const generation = ++this.generation;
    const response = await getUrl(deviceId);
    if (generation !== this.generation || response.device_id !== deviceId) {
      return false;
    }
    openProtocol(
      response.connect_url,
      buildRustDeskFallbackUrlFromTechiUrl(response.connect_url),
      onFallback,
    );
    return true;
  }
}

export const remoteSupportLaunchCoordinator = new RemoteSupportLaunchCoordinator();

export async function launchRemoteSupportConnect(
  deviceId: number,
  onFallback?: () => void,
): Promise<boolean> {
  return remoteSupportLaunchCoordinator.launch(deviceId, getConnectUrl, launchConnect, onFallback);
}
