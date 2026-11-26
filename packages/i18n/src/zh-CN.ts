/** 中文文案。单独成模块：界面只带当前语言，另一种在切换语言时按需加载。 */
import agents from '../locales/zh-CN/agents.json' with { type: 'json' }
import common from '../locales/zh-CN/common.json' with { type: 'json' }
import errors from '../locales/zh-CN/errors.json' with { type: 'json' }
import onboarding from '../locales/zh-CN/onboarding.json' with { type: 'json' }
import session from '../locales/zh-CN/session.json' with { type: 'json' }
import settings from '../locales/zh-CN/settings.json' with { type: 'json' }
import teams from '../locales/zh-CN/teams.json' with { type: 'json' }
import trial from '../locales/zh-CN/trial.json' with { type: 'json' }
import type { LocaleMessages } from './namespaces.js'

export const messages: LocaleMessages = {
  common,
  session,
  settings,
  agents,
  teams,
  trial,
  onboarding,
  errors,
}
