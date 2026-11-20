/** 英文文案。单独成模块：界面只带当前语言，另一种在切换语言时按需加载。 */
import agents from '../locales/en-US/agents.json' with { type: 'json' }
import common from '../locales/en-US/common.json' with { type: 'json' }
import errors from '../locales/en-US/errors.json' with { type: 'json' }
import onboarding from '../locales/en-US/onboarding.json' with { type: 'json' }
import session from '../locales/en-US/session.json' with { type: 'json' }
import settings from '../locales/en-US/settings.json' with { type: 'json' }
import trial from '../locales/en-US/trial.json' with { type: 'json' }
import type { LocaleMessages } from './namespaces.js'

export const messages: LocaleMessages = {
  common,
  session,
  settings,
  agents,
  trial,
  onboarding,
  errors,
}
