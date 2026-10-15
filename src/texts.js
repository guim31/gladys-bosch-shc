// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, action reports, command and scene action errors.
// Four languages, those of the Gladys interface; German says "du", Spanish
// "usted". test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './shc/http.js';

export const LANGUAGE_FALLBACK = 'en';

export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  noHost: {
    en: 'Enter the IP address of your Smart Home Controller in the configuration.',
    fr: "Saisissez l'adresse IP de votre Smart Home Controller dans la configuration.",
    de: 'Gib die IP-Adresse deines Smart Home Controllers in der Konfiguration ein.',
    es: 'Introduzca la dirección IP de su Smart Home Controller en la configuración.',
  },
  invalidHost: {
    en: 'Address not understood: type the IP address only, e.g. 192.168.1.20',
    fr: "Adresse incomprise : saisissez l'adresse IP seule, ex. 192.168.1.20",
    de: 'Adresse nicht verstanden: Gib nur die IP-Adresse ein, z. B. 192.168.1.20',
    es: 'Dirección no válida: escriba solo la dirección IP, p. ej. 192.168.1.20',
  },
  notPaired: {
    en: 'Not paired yet: press the button of the controller, then click "Pair".',
    fr: 'Pas encore appairé : appuyez sur le bouton du contrôleur, puis cliquez sur « Appairer ».',
    de: 'Noch nicht gekoppelt: Drücke die Taste des Controllers und klicke dann auf „Koppeln“.',
    es: 'Aún no emparejado: pulse el botón del controlador y luego haga clic en «Emparejar».',
  },
};

// One short explanation per error kind (src/shc/http.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'the controller does not answer at this address',
    fr: 'le contrôleur ne répond pas à cette adresse',
    de: 'der Controller antwortet unter dieser Adresse nicht',
    es: 'el controlador no responde en esta dirección',
  },
  [ERROR_KINDS.CERTIFICATE]: {
    en: 'the controller certificate is not a valid Bosch certificate',
    fr: "le certificat du contrôleur n'est pas un certificat Bosch valide",
    de: 'das Zertifikat des Controllers ist kein gültiges Bosch-Zertifikat',
    es: 'el certificado del controlador no es un certificado Bosch válido',
  },
  [ERROR_KINDS.REFUSED]: {
    en: 'the controller refuses Gladys (pair it again)',
    fr: 'le contrôleur refuse Gladys (appairez-le de nouveau)',
    de: 'der Controller lehnt Gladys ab (kopple ihn erneut)',
    es: 'el controlador rechaza a Gladys (vuelva a emparejarlo)',
  },
  [ERROR_KINDS.NOT_PAIRING]: {
    en: 'the controller is not in pairing mode (press its button until the lights flash)',
    fr: "le contrôleur n'est pas en mode appairage (appuyez sur son bouton jusqu'au clignotement)",
    de: 'der Controller ist nicht im Kopplungsmodus (halte seine Taste, bis die LEDs blinken)',
    es: 'el controlador no está en modo emparejamiento (pulse su botón hasta que parpadeen las luces)',
  },
  [ERROR_KINDS.WRONG_PASSWORD]: {
    en: 'system password refused',
    fr: 'mot de passe système refusé',
    de: 'Systempasswort abgelehnt',
    es: 'contraseña del sistema rechazada',
  },
  [ERROR_KINDS.PROTOCOL]: {
    en: 'unexpected answer from the controller',
    fr: 'réponse inattendue du contrôleur',
    de: 'unerwartete Antwort des Controllers',
    es: 'respuesta inesperada del controlador',
  },
};

/** "Bosch Smart Home: <reason>", in every language. */
export const errorStatus = (kind) =>
  Object.fromEntries(
    Object.entries(ERROR_TEXT[kind] ?? ERROR_TEXT[ERROR_KINDS.PROTOCOL]).map(([lang, text]) => [
      lang,
      `Bosch Smart Home: ${text}`,
    ]),
  );

// Reports of the configuration actions and messages of the commands.
export const ACTION_TEXT = {
  en: {
    paired: (count) => `Paired. ${count} device(s) found: add them from the Discovery tab.`,
    missingPassword: 'Enter the system password of the controller in the configuration first.',
    pairingFailed: (reason) => `Pairing failed: ${reason}.`,
    connected: (version, count) =>
      `Connected to the controller (software ${version}), ${count} device(s) supported.`,
    connectionFailed: (reason) => `Connection failed: ${reason}.`,
    heatingOff: 'The heating of this room is off (summer mode): switch the mode on first.',
    unknownDevice: 'This device is not known to the controller any more.',
    readOnly: 'This feature cannot be controlled.',
    armingDisabled: 'Arming from Gladys is disabled: enable it in the configuration.',
    noIntrusion: 'This controller has no intrusion detection system.',
    armed: 'The intrusion alarm is arming.',
  },
  fr: {
    paired: (count) =>
      `Appairé. ${count} appareil(s) trouvé(s) : ajoutez-les depuis l'onglet Découverte.`,
    missingPassword:
      "Saisissez d'abord le mot de passe système du contrôleur dans la configuration.",
    pairingFailed: (reason) => `Échec de l'appairage : ${reason}.`,
    connected: (version, count) =>
      `Connecté au contrôleur (logiciel ${version}), ${count} appareil(s) pris en charge.`,
    connectionFailed: (reason) => `Échec de la connexion : ${reason}.`,
    heatingOff: "Le chauffage de cette pièce est à l'arrêt (mode été) : réactivez d'abord le mode.",
    unknownDevice: 'Le contrôleur ne connaît plus cet appareil.',
    readOnly: 'Cette fonctionnalité ne se pilote pas.',
    armingDisabled: "L'armement depuis Gladys est désactivé : activez-le dans la configuration.",
    noIntrusion: "Ce contrôleur n'a pas de système d'alarme intrusion.",
    armed: "L'alarme intrusion s'arme.",
  },
  de: {
    paired: (count) => `Gekoppelt. ${count} Gerät(e) gefunden: Füge sie im Tab „Entdecken“ hinzu.`,
    missingPassword: 'Gib zuerst das Systempasswort des Controllers in der Konfiguration ein.',
    pairingFailed: (reason) => `Kopplung fehlgeschlagen: ${reason}.`,
    connected: (version, count) =>
      `Mit dem Controller verbunden (Software ${version}), ${count} Gerät(e) unterstützt.`,
    connectionFailed: (reason) => `Verbindung fehlgeschlagen: ${reason}.`,
    heatingOff:
      'Die Heizung dieses Raums ist aus (Sommermodus): Schalte zuerst den Modus wieder ein.',
    unknownDevice: 'Der Controller kennt dieses Gerät nicht mehr.',
    readOnly: 'Diese Funktion lässt sich nicht steuern.',
    armingDisabled:
      'Das Scharfschalten aus Gladys ist deaktiviert: Aktiviere es in der Konfiguration.',
    noIntrusion: 'Dieser Controller hat kein Einbruchmeldesystem.',
    armed: 'Der Einbruchalarm wird scharf geschaltet.',
  },
  es: {
    paired: (count) =>
      `Emparejado. ${count} dispositivo(s) encontrado(s): añádalos desde la pestaña Descubrimiento.`,
    missingPassword:
      'Introduzca primero la contraseña del sistema del controlador en la configuración.',
    pairingFailed: (reason) => `El emparejamiento ha fallado: ${reason}.`,
    connected: (version, count) =>
      `Conectado al controlador (software ${version}), ${count} dispositivo(s) compatibles.`,
    connectionFailed: (reason) => `La conexión ha fallado: ${reason}.`,
    heatingOff:
      'La calefacción de esta habitación está apagada (modo verano): active primero el modo.',
    unknownDevice: 'El controlador ya no conoce este dispositivo.',
    readOnly: 'Esta función no se puede controlar.',
    armingDisabled: 'El armado desde Gladys está desactivado: actívelo en la configuración.',
    noIntrusion: 'Este controlador no tiene sistema de alarma de intrusión.',
    armed: 'La alarma de intrusión se está armando.',
  },
};

const isTranslated = (value) =>
  value !== null && typeof value === 'object' && typeof value[LANGUAGE_FALLBACK] === 'string';

/**
 * A text of ACTION_TEXT in every language. Functions are called with `args`;
 * an argument that is itself a multi-language object is passed in the
 * language of the text.
 */
export function actionMessage(key, ...args) {
  return Object.fromEntries(
    Object.entries(ACTION_TEXT).map(([lang, texts]) => {
      const text = texts[key];
      const localArgs = args.map((arg) => (isTranslated(arg) ? pick(arg, lang) : arg));
      return [lang, typeof text === 'function' ? text(...localArgs) : text];
    }),
  );
}

/** A localized Error: its message in the configured language. */
export function localizedError(key, language, ...args) {
  return new Error(pick(actionMessage(key, ...args), language));
}
