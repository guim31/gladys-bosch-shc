# Controller fixtures

A house with every device family the integration supports, a few it ignores
(Twinguard, camera, presence simulation) and the intrusion detection system,
as the fake controller (`test/helpers/fakeController.js`) serves them.

- `devices.json`: `GET /smarthome/devices`;
- `services.json`: `GET /smarthome/services` (the `DeviceServiceData` of
  every device, with `faults` for the low batteries);
- `rooms.json`: `GET /smarthome/rooms`;
- `intrusion-system.json`: `GET /smarthome/intrusion/states/system`;
- `information.json`: `GET /smarthome/information`;
- `public-information.json`: `GET /smarthome/public/information` (port 8446).

The shapes follow the Bosch local API documentation and the models and states
of boschshcpy (BSD-3-Clause), written by hand: no real controller answer was
available. Every id, serial number and MAC address is invented (HomeMatic IP
ids keep their `3014F711A000` prefix, Zigbee ids an IEEE-looking address), and
the controller address of the tests is `127.0.0.1`. Replace them with real,
anonymized answers once `scripts/probe.mjs` has been run on a controller.
