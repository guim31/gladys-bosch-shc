# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.1] - 2026-10-15

### Added

- Bosch Smart Home Controller (I and II) over its local API, without any
  cloud: pairing from the configuration (press the button of the controller,
  then "Pair"), with a client certificate generated in the container and kept
  in `/data`; the system password is erased once paired.
- Real-time states through the event subscription of the controller (long
  polling), and a full read every 15 minutes as a safety net.
- Heating per room: temperature, setpoint (5 to 30 °C by half degrees), mode
  (off, manual, schedule) and heating demand.
- Radiator and room thermostats (temperature, humidity, low battery),
  door/window contacts, motion detectors, smoke detectors, water leak
  detectors, universal switches (low battery).
- Smart plugs (on/off, power, energy), light switches and micromodules
  (on/off), shutters and awnings (position, open/close/stop).
- The intrusion alarm, read-only: armed, alarm triggered, status. Arming from
  a scene is possible once allowed in the configuration; disarming and muting
  are never offered.
- Scene triggers "Smoke detector in alarm" (detected or relayed) and
  "Universal switch pressed" (button, short or long press); scene action "Arm
  the intrusion alarm".
- Dashboard widget "Bosch Smart Home": controller, alarm, open doors and
  windows, low batteries, devices not answering.
- Unavailable devices flagged unreachable; new, renamed and removed devices
  follow the controller.
- English, French, German and Spanish, for the configuration, the names, the
  messages and the documentation.

[Unreleased]: https://github.com/guim31/gladys-bosch-shc/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/guim31/gladys-bosch-shc/releases/tag/v1.0.1
