import { promises as dns } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";
import {
  isMetadataHost,
  isPrivateIpv4,
  isPrivateIpv6,
} from "./network-address";

function createDispatcher(allowPrivateHosts: boolean): Agent {
  const lookup: LookupFunction = (hostname, options, callback) => {
    // Return only this checked result to the connector: no second resolution.
    // Check every answer even when Node requested only one address.
    dns.lookup(hostname, { all: true, verbatim: true }).then(
      (records) => {
        if (
          records.length === 0 ||
          records.some(
            ({ address }) =>
              !isIP(address) ||
              isMetadataHost(address) ||
              (!allowPrivateHosts &&
                (isPrivateIpv4(address) || isPrivateIpv6(address)))
          )
        ) {
          callback(
            new Error("Blocked URL: DNS resolved to a disallowed address"),
            "",
            0
          );
          return;
        }
        const candidates = options.family
          ? records.filter((record) => record.family === options.family)
          : records;
        if (!candidates.length) {
          callback(new Error("No addresses for the requested family"), "", 0);
        } else if (options.all) {
          callback(null, candidates);
        } else {
          callback(null, candidates[0].address, candidates[0].family);
        }
      },
      (error: Error) => callback(error, "", 0)
    );
  };
  return new Agent({ connect: { lookup, timeout: 15_000 }, maxOrigins: 128 });
}

// Never share a pool across policies: a public-only request must not reuse a
// socket opened earlier under the local-AI exception for the same hostname.
const publicDispatcher = createDispatcher(false);
const privateDispatcher = createDispatcher(true);
export function outboundDispatcher(allowPrivateHosts: boolean): Agent {
  return allowPrivateHosts ? privateDispatcher : publicDispatcher;
}
