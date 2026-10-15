// -----------------------------------------------------------------------------
// Dashboard widget "Bosch Smart Home": the state of the house at a glance,
// what no single device feature says — is the controller reachable, which
// doors and windows are open, which batteries are low, which devices do not
// answer, how the intrusion alarm stands. Read-only on purpose: nothing that
// opens, arms or disarms sits behind a tap on a dashboard.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS, createLogger } from '@gladysassistant/integration-sdk';
import { WIDGET_KEY } from './hub.js';
import { INTRUSION_TEXT, intrusionStatus } from './devices.js';
import { LANGUAGES } from './config.js';

const logger = createLogger({ name: 'bosch-widgets' });

export const TEXT = {
  controller: {
    en: 'Controller',
    fr: 'Contrôleur',
    de: 'Controller',
    es: 'Controlador',
  },
  connected: { en: 'Connected', fr: 'Connecté', de: 'Verbunden', es: 'Conectado' },
  unreachable: {
    en: 'Unreachable',
    fr: 'Injoignable',
    de: 'Nicht erreichbar',
    es: 'Inaccesible',
  },
  connecting: {
    en: 'Connecting…',
    fr: 'Connexion…',
    de: 'Verbinde…',
    es: 'Conectando…',
  },
  refused: {
    en: 'Pairing refused',
    fr: 'Appairage refusé',
    de: 'Kopplung abgelehnt',
    es: 'Emparejamiento rechazado',
  },
  notPaired: {
    en: 'Not paired',
    fr: 'Non appairé',
    de: 'Nicht gekoppelt',
    es: 'No emparejado',
  },
  notConfigured: {
    en: 'Not configured',
    fr: 'Non configuré',
    de: 'Nicht konfiguriert',
    es: 'No configurado',
  },
  alarm: {
    en: 'Intrusion alarm',
    fr: 'Alarme intrusion',
    de: 'Einbruchalarm',
    es: 'Alarma de intrusión',
  },
  open: {
    en: 'Open doors and windows',
    fr: 'Portes et fenêtres ouvertes',
    de: 'Offene Türen und Fenster',
    es: 'Puertas y ventanas abiertas',
  },
  battery: {
    en: 'Low batteries',
    fr: 'Piles faibles',
    de: 'Schwache Batterien',
    es: 'Pilas bajas',
  },
  offline: {
    en: 'Devices not answering',
    fr: 'Appareils muets',
    de: 'Geräte ohne Antwort',
    es: 'Dispositivos sin respuesta',
  },
  openList: { en: 'Open', fr: 'Ouvert', de: 'Offen', es: 'Abierto' },
  batteryList: { en: 'Battery', fr: 'Pile', de: 'Batterie', es: 'Pila' },
  offlineList: { en: 'Silent', fr: 'Muet', de: 'Stumm', es: 'Sin respuesta' },
  allClear: {
    en: 'Everything is closed, no battery to change.',
    fr: 'Tout est fermé, aucune pile à changer.',
    de: 'Alles ist geschlossen, keine Batterie zu wechseln.',
    es: 'Todo está cerrado, ninguna pila que cambiar.',
  },
};

const pickText = (key, language) => TEXT[key][language] ?? TEXT[key].en;

function controllerItem(summary, language) {
  let value;
  let color;
  if (!summary.configured) {
    [value, color] = ['notConfigured', WIDGET_COLORS.WARNING];
  } else if (!summary.paired) {
    [value, color] = ['notPaired', WIDGET_COLORS.WARNING];
  } else if (summary.state === 'connected') {
    [value, color] = ['connected', WIDGET_COLORS.SUCCESS];
  } else if (summary.error === 'refused') {
    [value, color] = ['refused', WIDGET_COLORS.DANGER];
  } else if (summary.state === 'down') {
    [value, color] = ['unreachable', WIDGET_COLORS.DANGER];
  } else {
    [value, color] = ['connecting', WIDGET_COLORS.NEUTRAL];
  }
  return {
    label: pickText('controller', language),
    icon: 'server',
    value: pickText(value, language),
    color,
  };
}

const ALARM_COLORS = {
  disarmed: WIDGET_COLORS.NEUTRAL,
  arming: WIDGET_COLORS.WARNING,
  armed: WIDGET_COLORS.SUCCESS,
  pre_alarm: WIDGET_COLORS.WARNING,
  alarm: WIDGET_COLORS.DANGER,
  muted: WIDGET_COLORS.WARNING,
  unknown: WIDGET_COLORS.NEUTRAL,
};

const countItem = (key, icon, list, language, badColor) => ({
  label: pickText(key, language),
  icon,
  value: list.length,
  color: list.length > 0 ? badColor : WIDGET_COLORS.SUCCESS,
});

/** The lines of the body text, cut to the 300 characters the core keeps. */
function details(summary, language) {
  const lines = [];
  const line = (key, names) => {
    if (names.length > 0) {
      // French typography puts a space before the colon.
      const colon = language === 'fr' ? ' : ' : ': ';
      lines.push(`${pickText(key, language)}${colon}${names.join(', ')}`);
    }
  };
  line('openList', summary.open);
  line('batteryList', summary.lowBattery);
  line('offlineList', summary.unreachable);
  const text = lines.join('\n');
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

/**
 * The widget content, from the hub summary.
 * @param {ReturnType<import('./hub.js').Hub['summary']>} summary
 * @param {string} language
 */
export function overviewContent(summary, language) {
  const lang = LANGUAGES.includes(language) ? language : 'en';
  const items = [controllerItem(summary, lang)];
  if (summary.state === 'connected' || summary.devices > 0) {
    if (summary.intrusion) {
      const status = intrusionStatus(summary.intrusion);
      items.push({
        label: pickText('alarm', lang),
        icon: 'shield',
        value: INTRUSION_TEXT[lang][status],
        color: ALARM_COLORS[status],
      });
    }
    items.push(
      countItem('open', 'maximize-2', summary.open, lang, WIDGET_COLORS.WARNING),
      countItem('battery', 'battery', summary.lowBattery, lang, WIDGET_COLORS.WARNING),
      countItem('offline', 'wifi-off', summary.unreachable, lang, WIDGET_COLORS.DANGER),
    );
  }
  const components = [{ type: 'status', items }];
  if (summary.state === 'connected') {
    components.push({
      type: 'text',
      variant: 'body',
      text: details(summary, lang) || pickText('allClear', lang),
    });
  }
  return {
    // The hub nudges the widget whenever what it shows changes: the TTL is a
    // safety net only.
    ttl_seconds: 600,
    components,
  };
}

export const WIDGETS = {
  [WIDGET_KEY]: {
    async get(hub, { language }) {
      logger.debug(`Widget ${WIDGET_KEY} requested`);
      return overviewContent(hub.summary(), language ?? hub.config?.language);
    },
  },
};
