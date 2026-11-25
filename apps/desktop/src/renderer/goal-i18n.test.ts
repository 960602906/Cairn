import { describe, expect, it } from 'vitest'
import { RESOURCES, SUPPORTED_LOCALES } from '@cairn/i18n'
import { GoalEndReason, GoalPauseReason, GoalVerdict } from '@cairn/protocol'

const STATUSES = ['active', 'paused', 'ended'] as const
const EVIDENCE_KINDS = ['tool', 'file', 'message', 'turn', 'judge'] as const

describe('goal i18n dynamic keys', () => {
  it('has a translation for every protocol enum value in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = RESOURCES[locale].session
      for (const status of STATUSES) {
        expect(messages[`goal.status.${status}`], `${locale}: goal.status.${status}`).toBeTruthy()
      }
      for (const verdict of GoalVerdict.options) {
        expect(
          messages[`goal.verdict.${verdict}`],
          `${locale}: goal.verdict.${verdict}`,
        ).toBeTruthy()
      }
      for (const reason of GoalPauseReason.options) {
        expect(messages[`goal.pause.${reason}`], `${locale}: goal.pause.${reason}`).toBeTruthy()
      }
      for (const reason of GoalEndReason.options) {
        expect(messages[`goal.end.${reason}`], `${locale}: goal.end.${reason}`).toBeTruthy()
      }
      for (const kind of EVIDENCE_KINDS) {
        expect(
          messages[`goal.evidence.kind.${kind}`],
          `${locale}: goal.evidence.kind.${kind}`,
        ).toBeTruthy()
      }
    }
  })
})
