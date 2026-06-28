import { SorobanIdentityError } from "./errors";

export interface ServerInfo {
  version: string;
  features: string[];
  minSdkVersion: string;
}

export class UnsupportedEndpointError extends Error {
  readonly code = "UNSUPPORTED_ENDPOINT" as const;
  readonly endpoint: string;

  constructor(endpoint: string) {
    super(`Server does not support endpoint: ${endpoint}`);
    this.name = "UnsupportedEndpointError";
    this.endpoint = endpoint;
  }
}

/**
 * Query server capabilities by calling GET /info on the provided base URL.
 *
 * @param baseUrl The server base URL (e.g. http://localhost:3030).
 * @returns {@link ServerInfo} with version, features, and minSdkVersion.
 * @throws {UnsupportedEndpointError} if the server returns 404 for /info.
 * @throws {SorobanIdentityError} on other network or HTTP failures.
 */
export async function getServerInfo(baseUrl: string): Promise<ServerInfo> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, "")}/info`);
  } catch (err) {
    throw new SorobanIdentityError(
      `getServerInfo: network error — ${err instanceof Error ? err.message : String(err)}`,
      { code: "NETWORK_ERROR", originalError: err },
    );
  }

  if (res.status === 404) {
    throw new UnsupportedEndpointError("/info");
  }

  if (!res.ok) {
    throw new SorobanIdentityError(
      `getServerInfo: unexpected HTTP ${res.status}`,
      { code: "NETWORK_ERROR" },
    );
  }

  return res.json() as Promise<ServerInfo>;
}
