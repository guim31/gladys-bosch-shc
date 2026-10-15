# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration handles:

- **Secrets**: the system password of the controller is a `secret` field of
  the Gladys configuration. It is sent once, to the controller only, during
  the pairing (`Systempassword` header, HTTPS on port 8443), then erased from
  the configuration. It is never written to `/data` nor to the logs.
- **Stored in `/data`**, readable by the container user only (mode 0600):
  `bosch-shc-client-key.pem` (the RSA private key of the pairing),
  `bosch-shc-client-cert.pem` (its self-signed certificate, registered on the
  controller) and `bosch-shc.json` (the client id, the address at pairing time
  and the pairing date). Whoever holds the key can act on the controller as
  Gladys does: remove the pairing in the Bosch app to revoke it.
- **Network**: requests go only to the controller address typed in the
  configuration, on the local network: ports 8443 (pairing) and 8444 (API,
  mutual TLS). The controller certificate is checked against the bundled Bosch
  root authority (not its host name, which is not the IP address), unless the
  user ticks "Do not check the controller certificate". The integration opens
  no port and calls no cloud service.
- **Safety**: the intrusion alarm can only be armed, and only when the user
  allowed it; disarming and muting it are not implemented.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
the Bosch Smart Home Controller and its app, and the other devices and
services of your network.
