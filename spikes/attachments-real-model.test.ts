// 真实模型验收（spike）：用 DeepSeek（deepseek-flash，支持图片输入）实测附件管线。
//
// - 需要环境变量 DEEPSEEK_API_KEY，没有时整个文件跳过；不参与覆盖率，不在默认 test include 里。
// - 走应用的同一套代码：attachment-service（保存 / 类型识别 / 文字抽取）→ @cairn/runtime-pi
//   的 toPiMessages + bindModel → 真实 DeepSeek API。
// - 运行：DEEPSEEK_API_KEY=... pnpm vitest run spikes/attachments-real-model.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync, zlibSync } from 'fflate'
import { bindModel, fromPiAssistant, toPiMessages } from '@cairn/runtime-pi'
import type { CanonicalMessage, ContentPart } from '@cairn/protocol'
import type { ResolvedModel } from '@cairn/core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { createAttachmentService } from '../apps/desktop/src/main/services/attachment-service.js'

/** 从环境变量或本机 `~/.cairn-test.env`（0600）读取；命令行与仓库都不出现 Key。 */
function apiKey(): string | undefined {
  const fromEnv = process.env.DEEPSEEK_API_KEY
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  try {
    const content = readFileSync(join(homedir(), '.cairn-test.env'), 'utf8')
    return /^DEEPSEEK_API_KEY=(.*)$/m.exec(content)?.[1]?.trim()
  } catch {
    return undefined
  }
}

const API_KEY = apiKey()

// ---------------------------------------------------------------------------
// 测试环境
// ---------------------------------------------------------------------------

/** 内存 blob 存储（与 attachment-service.test.ts 的 memoryBlobs 相同语义）。 */
function memoryBlobs() {
  const files = new Map<string, Buffer>()
  let next = 0
  return {
    put: async (bytes: Uint8Array) => {
      const hash = `spike-${++next}`
      files.set(hash, Buffer.from(bytes))
      return hash
    },
    get: async (hash: string) => files.get(hash),
  }
}

const resolved: ResolvedModel = {
  ref: { providerId: 'deepseek', modelId: 'deepseek-flash' },
  providerKind: 'openai',
  baseUrl: 'https://api.deepseek.com',
  apiKey: API_KEY,
  profile: {
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    supportsTools: true,
    supportsParallelToolCalls: true,
    supportsReasoning: true,
  },
}

/** 发一轮消息，取回模型正文；出错时把 pi 的说明带出来。 */
async function ask(messages: CanonicalMessage[]): Promise<string> {
  const binding = bindModel(resolved)
  const message: AssistantMessage = await binding.complete(
    {
      systemPrompt:
        'You are a helpful assistant. Answer with only the requested value, no explanation.',
      messages: toPiMessages(messages, binding.identity),
    },
    { maxTokens: 4000 },
  )
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    throw new Error(`模型请求失败（${message.stopReason}）：${JSON.stringify(message)}`)
  }
  const text = fromPiAssistant(message, resolved.ref)
    .content.filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
  return text
}

/** 图片走 ContentPart.data（与 session-manager 的 hydrateContent 相同）。 */
function userTurn(content: readonly ContentPart[], context?: string): CanonicalMessage {
  return {
    role: 'user',
    content: [
      ...content,
      ...(context === undefined ? [] : [{ type: 'text' as const, text: context }]),
    ],
    ts: 1,
  }
}

const secretQuestion =
  '下面这条消息附带的附件内容里有一个以 SECRET- 开头的秘密代码。请只回答这个代码本身，不要任何解释。'

/** 归一化回答：去掉引号与空白，全大写，便于断言。 */
function normalized(answer: string): string {
  return answer.toUpperCase().replaceAll(/["'`*_\s]/g, '')
}

// ---------------------------------------------------------------------------
// 附件内容
// ---------------------------------------------------------------------------

// PNG：左半边纯红、右半边纯蓝。
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  new DataView(out.buffer).setUint32(0, data.length)
  out.set(strToU8(type), 4)
  out.set(data, 8)
  new DataView(out.buffer).setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

function colorPng(
  width: number,
  height: number,
  left: [number, number, number],
  right: [number, number, number],
): Uint8Array {
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3)
    raw[row] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = x < width / 2 ? left : right
      raw[row + 1 + x * 3] = r
      raw[row + 2 + x * 3] = g
      raw[row + 3 + x * 3] = b
    }
  }
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  return new Uint8Array([
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...pngChunk('IHDR', ihdr),
    ...pngChunk('IDAT', zlibSync(raw)),
    ...pngChunk('IEND', new Uint8Array(0)),
  ])
}

const RED_BLUE_PNG = colorPng(200, 100, [255, 0, 0], [0, 0, 255])

// PDF：一页，两行 Helvetica 文字（偏移量自算，xref 合法）。
function minimalPdf(lines: readonly string[]): Uint8Array {
  const stream = lines
    .map((line, index) => `BT /F1 24 Tf 72 ${700 - index * 30} Td (${line}) Tj ET`)
    .join('\n')
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const header = '%PDF-1.4\n'
  let body = ''
  const offsets: number[] = [0]
  let cursor = header.length
  objects.forEach((object, index) => {
    offsets.push(cursor)
    const line = `${index + 1} 0 obj\n${object}\nendobj\n`
    body += line
    cursor += line.length
  })
  const xref = offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')
  const xrefOffset = cursor
  const trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  return strToU8(header + body + trailer)
}

const SECRET_PDF = minimalPdf(['Cairn attachment spike', 'SECRET-PDF-42'])

// OOXML：用 fflate 打包（与应用解包同库）。
function zip(entries: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(entries).map(([path, text]) => [path, strToU8(text)])),
  )
}

const SECRET_XLSX = zip({
  'xl/workbook.xml':
    '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml':
    '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>name</t></is></c><c r="B1" t="inlineStr"><is><t>code</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>secret</t></is></c><c r="B2" t="inlineStr"><is><t>SECRET-XLSX-17</t></is></c></row></sheetData></worksheet>',
})

const SECRET_DOCX = zip({
  'word/document.xml':
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>SECRET-DOCX-7</w:t></w:r></w:p></w:body></w:document>',
})

const SECRET_PPTX = zip({
  'ppt/slides/slide1.xml':
    '<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>SECRET-PPTX-9</a:t></p:sld>',
})

const SECRET_CSV = strToU8('name,value\nSECRET-CSV,5')

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe.skipIf(API_KEY === undefined)('真实模型附件验收（DeepSeek deepseek-flash）', () => {
  const service = createAttachmentService(memoryBlobs())

  it('粘贴的图片：模型真的看到了图（左红右蓝）', async () => {
    const saved = await service.save({
      name: '截图.png',
      mimeType: 'application/octet-stream',
      data: Buffer.from(RED_BLUE_PNG).toString('base64'),
    })
    expect(saved.kind).toBe('image')
    expect(saved.mimeType).toBe('image/png')
    const answer = await ask([
      userTurn([
        { type: 'text', text: '这张图片左半边是什么颜色？只回答颜色名。' },
        {
          type: 'image',
          blobRef: saved.blobRef,
          mimeType: saved.mimeType,
          data: Buffer.from(RED_BLUE_PNG).toString('base64'),
        },
      ]),
    ])
    console.log(`[png] 模型回答：${answer.trim()}`)
    expect(normalized(answer)).toMatch(/红|RED/)
  }, 180_000)

  it('PDF：抽取文字进上下文，模型读得到', async () => {
    const saved = await service.save({
      name: 'report.pdf',
      mimeType: 'application/pdf',
      data: Buffer.from(SECRET_PDF).toString('base64'),
    })
    expect(saved.kind).toBe('file')
    const context = await service.expand([saved])
    expect(context).toContain('SECRET-PDF-42')
    const answer = await ask([userTurn([{ type: 'text', text: secretQuestion }], context)])
    console.log(`[pdf] 模型回答：${answer.trim()}`)
    expect(normalized(answer)).toContain('SECRET-PDF-42')
  }, 180_000)

  it('XLSX：表格内容进上下文，模型读得到', async () => {
    const saved = await service.save({
      name: 'data.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: Buffer.from(SECRET_XLSX).toString('base64'),
    })
    expect(saved.kind).toBe('file')
    const context = await service.expand([saved])
    expect(context).toContain('SECRET-XLSX-17')
    const answer = await ask([userTurn([{ type: 'text', text: secretQuestion }], context)])
    console.log(`[xlsx] 模型回答：${answer.trim()}`)
    expect(normalized(answer)).toContain('SECRET-XLSX-17')
  }, 180_000)

  it('DOCX：正文进上下文，模型读得到', async () => {
    const saved = await service.save({
      name: 'doc.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      data: Buffer.from(SECRET_DOCX).toString('base64'),
    })
    expect(saved.kind).toBe('file')
    const context = await service.expand([saved])
    expect(context).toContain('SECRET-DOCX-7')
    const answer = await ask([userTurn([{ type: 'text', text: secretQuestion }], context)])
    console.log(`[docx] 模型回答：${answer.trim()}`)
    expect(normalized(answer)).toContain('SECRET-DOCX-7')
  }, 180_000)

  it('PPTX：幻灯片文字进上下文，模型读得到', async () => {
    const saved = await service.save({
      name: 'slides.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      data: Buffer.from(SECRET_PPTX).toString('base64'),
    })
    expect(saved.kind).toBe('file')
    const context = await service.expand([saved])
    expect(context).toContain('SECRET-PPTX-9')
    const answer = await ask([userTurn([{ type: 'text', text: secretQuestion }], context)])
    console.log(`[pptx] 模型回答：${answer.trim()}`)
    expect(normalized(answer)).toContain('SECRET-PPTX-9')
  }, 180_000)

  it('CSV：文本内容进上下文，模型读得到', async () => {
    const saved = await service.save({
      name: 'table.csv',
      mimeType: 'text/csv',
      data: Buffer.from(SECRET_CSV).toString('base64'),
    })
    expect(saved.kind).toBe('file')
    const context = await service.expand([saved])
    expect(context).toContain('SECRET-CSV')
    const answer = await ask([userTurn([{ type: 'text', text: secretQuestion }], context)])
    console.log(`[csv] 模型回答：${answer.trim()}`)
    expect(normalized(answer)).toContain('SECRET-CSV')
  }, 180_000)
})
