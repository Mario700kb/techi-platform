import {
  createConnectLaunchToken,
  type ConnectLaunchTokenResponse,
} from "../api/remoteSupport";
import { clickProtocolUrl, validateTokenOnlyConnectUrl } from "./rustdeskLaunch";

type TokenFactory = (deviceId: number) => Promise<ConnectLaunchTokenResponse>;
type ProtocolLauncher = (url: string) => void;

export class RemoteSupportLaunchCoordinator {
  private generation = 0;

  invalidate(): void {
    this.generation += 1;
  }

  async launch(
    deviceId: number,
    createToken: TokenFactory = createConnectLaunchToken,
    openProtocol: ProtocolLauncher = clickProtocolUrl,
  ): Promise<boolean> {
    const generation = ++this.generation;
    const response = await createToken(deviceId);
    if (generation !== this.generation || response.device_id !== deviceId) {
      return false;
    }
    openProtocol(validateTokenOnlyConnectUrl(response.connect_url));
    return true;
  }
}

export const remoteSupportLaunchCoordinator = new RemoteSupportLaunchCoordinator();

export async function launchRemoteSupportConnect(deviceId: number): Promise<boolean> {
  return remoteSupportLaunchCoordinator.launch(deviceId);
}
