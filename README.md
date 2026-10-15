# Bosch Smart Home for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) integration for the **Bosch
Smart Home Controller** (first and second generation), over the local API of
the controller: no cloud, no Bosch account, real-time states.

> **Developed without the hardware: feedback welcome.** The integration was
> built from the public local API documentation of Bosch and from the
> [boschshcpy](https://github.com/tschamm/boschshcpy) library, and tested
> end to end against a simulated controller (real HTTPS and client
> certificates), not against a real one. Please report what works and what
> does not on the [Gladys forum](https://community.gladysassistant.com) or in
> the [issues](https://github.com/guim31/gladys-bosch-shc/issues).

This project is not affiliated with, nor endorsed by, Bosch. "Bosch" and
"Bosch Smart Home" are trademarks of their owners.

## Features

- **Pairing** from the Gladys configuration: press the button of the
  controller, click **Pair**. The integration generates its own client
  certificate (RSA 2048, kept in `/data`) and registers it with the system
  password, which is then erased from Gladys.
- **Heating per room**: temperature, setpoint (5 to 30 °C, by half degrees),
  mode (off, manual, schedule), heating demand.
- **Radiator and room thermostats**: temperature, humidity, low battery.
- **Sensors**: door/window contacts, motion detectors, smoke detectors, water
  leak detectors, all with their low battery.
- **Plugs and switches**: on/off, power and energy (the energy counter feeds
  the energy screens of Gladys).
- **Shutters and awnings**: position, open, close, stop.
- **Intrusion alarm**, read-only: armed, alarm triggered, status. Arming from
  a scene only when allowed in the configuration; never disarming nor muting.
- **Scene triggers**: _Smoke detector in alarm_ (detected here or relayed),
  _Universal switch pressed_ (button, short or long press).
- **Scene action**: _Arm the intrusion alarm_ (opt-in).
- **Dashboard widget**: controller, alarm, open doors and windows, low
  batteries, devices not answering.
- Texts in English, French, German and Spanish.

The full user documentation, with the pairing step by step:
[English](docs/en.md), [Français](docs/fr.md), [Deutsch](docs/de.md),
[Español](docs/es.md).

## Requirements

- Gladys Assistant 5.1.0 or later.
- A Bosch Smart Home Controller I or II, set up with the Bosch Smart Home app,
  on the local network of Gladys, with a fixed IP address.
- Its system password, and access to its button for the pairing.
- Gladys must reach the controller on TCP ports 8443 (pairing) and 8444 (API).

## Installation

In Gladys: **Integrations** → **Install from GitHub**, then
`https://github.com/guim31/gladys-bosch-shc`. Once installed, open the
integration, enter the IP address and the system password, save, press the
button of the controller until its lights flash, and click **Pair**. The
devices then appear in the **Discovery** tab.

## How it works

- **Pairing** (`src/shc/x509.js`, `src/hub.js`): an RSA key pair and a
  self-signed X.509 certificate are built with `node:crypto` (the DER encoding
  is done in the integration, no dependency), then `POST
/smarthome/clients` on port 8443 with the `Systempassword` header, as a
  `ROLE_RESTRICTED_CLIENT` named `oss_Gladys_Assistant` (the `oss_` prefix is
  required by the terms of the local API).
- **API** (`src/shc/client.js`): mutual TLS on port 8444. The controller
  certificate is checked against the Bosch "Smart Home Controller Productive
  Root CA" bundled in `src/shc/bosch-root-ca.pem`; the host name is not
  checked (the certificate names the controller, not its IP address).
- **Real time**: one event subscription (`RE/subscribe`), read by long
  polling (`RE/longPoll`, 30 s per request), as Bosch recommends. A lost
  subscription (24 h at most, 5 min idle) is renewed and followed by a full
  read, so the events of the gap are not lost.
- **Safety net**: a full read (`/devices`, `/services`, `/rooms`,
  `/intrusion/states/system`) every 15 minutes. The devices are published
  with `should_poll: false`: the core scheduler is not relied upon
  (GladysAssistant/Gladys#3198); `onPoll` remains as a fallback re-reading one
  device.
- **States**: only the changes are published (SDK deduplication), unchanged
  values are re-sent every 6 hours; everything is re-sent when a device is
  added in Gladys.
- **Requests**: one event request open at a time, four requests every 15
  minutes, plus the commands. Nothing else.

## Checked against a simulated controller, and what was not

The tests (`npm test`) run the integration against a fake controller
(`test/helpers/fakeController.js`): three real HTTPS servers signed by a test
authority, the pairing in and out of pairing mode, the client certificate
checked on every request, the JSON-RPC long polling and its expiry. The
fixtures (`test/fixtures/shc`) follow the shapes of the Bosch documentation
and of boschshcpy, with invented ids.

What only a real controller can confirm, and `scripts/probe.mjs` checks
read-only (`node scripts/probe.mjs <ip>`, plus `--cert`/`--key` of a pairing
for the authenticated part):

- how the pairing port refuses a session outside pairing mode, and how the
  API refuses an unknown client (TLS alert or HTTP 401);
- that the controller certificate chains to the bundled Bosch root (the
  Bosch issuing authority of 2015 expired in August 2025);
- the exact services and state keys of each model, the shape of the events.

## Limitations

- One controller per Gladys.
- Not supported: Twinguard, cameras, outdoor siren, dimmers and coloured
  lights, heating circuits and boilers, presence simulation, Bosch scenarios
  and automations; the valve position, the illuminance of motion detector II,
  the boost and eco presets, the device settings.
- The intrusion alarm is never disarmed nor muted from Gladys.
- The local API of Bosch is for private, non-commercial use.

## Development

```bash
npm install
npm test                 # node --test, against the SDK's fake Gladys and a fake controller
npm run lint
npm run format:check
npx -y github:GladysAssistant/integration-store .   # store checks
```

Versions, tags and releases belong to the **Release** workflow (Actions →
Release): never edit `version` by hand.

## Credits

- [boschshcpy](https://github.com/tschamm/boschshcpy) by Clemens-Alexander
  Brust and Thomas Schamm (BSD-3-Clause): the protocol, the pairing request,
  the certificate it generates, the model list and the meaning of the states.
  The Bosch root certificate is taken from it.
- The Home Assistant integration
  [`bosch_shc`](https://github.com/home-assistant/core/tree/dev/homeassistant/components/bosch_shc)
  (Apache-2.0), by Thomas Schamm and contributors: the mapping of the heating
  modes, the deduplication of the motion and alarm events.
- The [Bosch Smart Home Controller Local REST API](https://github.com/BoschSmartHome/bosch-shc-api-docs)
  documentation (read, not copied: it is CC BY-NC-ND).

## License

[Apache-2.0](LICENSE).
