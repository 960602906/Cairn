import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'

const pdfMock = vi.hoisted(() => ({ getDocumentProxy: vi.fn() }))
vi.mock('unpdf', () => pdfMock)

import { attachmentText, ATTACHMENT_TEXT_MAX } from './attachment-text.js'

afterEach(() => {
  vi.restoreAllMocks()
  pdfMock.getDocumentProxy.mockReset()
})

const input = (name: string, bytes: Uint8Array | string, mimeType = '') => ({
  name,
  mimeType,
  bytes: typeof bytes === 'string' ? strToU8(bytes) : bytes,
})

function zip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  for (const [path, content] of Object.entries(files)) entries[path] = strToU8(content)
  return zipSync(entries)
}

/** 伪造中央目录里某个条目的解压后大小，触发解压时的压缩炸弹防护分支。 */
function fakeUncompressedSize(zipBytes: Uint8Array, entryName: string, size: number): Uint8Array {
  const bytes = Buffer.from(zipBytes)
  const nameAt = bytes.lastIndexOf(Buffer.from(entryName))
  if (nameAt === -1) throw new Error('entry not found in zip')
  const entryAt = nameAt - 46
  if (bytes.readUInt32LE(entryAt) !== 0x02014b50) {
    throw new Error('central directory signature missing')
  }
  bytes.writeUInt32LE(size, entryAt + 24)
  return bytes
}

describe('attachmentText: 文本文件', () => {
  it('按扩展名或类型解码文本', async () => {
    expect(await attachmentText(input('notes.md', '# 标题\n正文'))).toBe('# 标题\n正文')
    expect(await attachmentText(input('data.bin', 'hello', 'text/plain'))).toBe('hello')
    expect(await attachmentText(input('data.bin', '{"a":1}', 'application/json'))).toBe('{"a":1}')
    expect(await attachmentText(input('data.bin', '<x/>', 'application/xml'))).toBe('<x/>')
    expect(await attachmentText(input('script.unknown', 'x = 1', 'text/x-python'))).toBe('x = 1')
  })

  it('二进制、空白和未知类型没有可给模型的文字', async () => {
    expect(await attachmentText(input('raw.txt', new Uint8Array([1, 0, 2])))).toBeUndefined()
    expect(await attachmentText(input('empty.md', '   \n\t '))).toBeUndefined()
    expect(
      await attachmentText(input('a.xyz', 'plain', 'application/octet-stream')),
    ).toBeUndefined()
  })

  it('超长文本截断并标注', async () => {
    const text = await attachmentText(input('long.txt', 'a'.repeat(ATTACHMENT_TEXT_MAX + 100)))
    expect(text).toHaveLength(ATTACHMENT_TEXT_MAX + '\n[Content truncated]'.length)
    expect(text?.endsWith('[Content truncated]')).toBe(true)
  })
})

describe('attachmentText: PDF', () => {
  /** 与 unpdf（pdf.js）的 `TextItem | TextMarkedContent` 对齐的宽松条目类型。 */
  type FakePdfItem = { str?: string; hasEOL?: boolean; type?: string }

  function fakePdf(pages: number, pageText: (number: number) => string) {
    return {
      numPages: pages,
      getPage: vi.fn(async (number: number) => ({
        getTextContent: async (): Promise<{ items: FakePdfItem[] }> => ({
          items: pageText(number)
            .split('\n')
            .map((line, index, all) => ({ str: line, hasEOL: index < all.length - 1 })),
        }),
      })),
      cleanup: vi.fn(async () => undefined),
    }
  }

  it('按页抽取文字，跳过行尾标记外的条目', async () => {
    const pdf = fakePdf(3, (number) => `Page ${number}\ntail`)
    pdf.getPage.mockResolvedValueOnce({
      getTextContent: async () => ({
        items: [{ str: 'First', hasEOL: true }, { str: 'second' }, { type: 'beginMarkedContent' }],
      }),
    })
    pdfMock.getDocumentProxy.mockResolvedValueOnce(pdf)
    expect(await attachmentText(input('doc.pdf', new Uint8Array([1])))).toBe(
      'First\nsecond\n\nPage 2\ntail\n\nPage 3\ntail',
    )
    expect(pdf.getPage).toHaveBeenCalledTimes(3)
    expect(pdf.cleanup).toHaveBeenCalledOnce()
  })

  it('最多读 50 页，达到字符上限就提前停止', async () => {
    const many = fakePdf(60, (number) => `P${number}`)
    pdfMock.getDocumentProxy.mockResolvedValueOnce(many)
    await attachmentText(input('doc.pdf', new Uint8Array([1])))
    expect(many.getPage).toHaveBeenCalledTimes(50)
    expect(many.cleanup).toHaveBeenCalledOnce()

    const huge = fakePdf(10, () => 'x'.repeat(ATTACHMENT_TEXT_MAX))
    pdfMock.getDocumentProxy.mockResolvedValueOnce(huge)
    await attachmentText(input('doc.pdf', new Uint8Array([1])))
    expect(huge.getPage).toHaveBeenCalledTimes(1)
  })

  it('解析失败或清理失败时返回 undefined', async () => {
    pdfMock.getDocumentProxy.mockRejectedValueOnce(new Error('encrypted'))
    expect(await attachmentText(input('doc.pdf', new Uint8Array([1])))).toBeUndefined()

    const pdf = fakePdf(1, () => 'x')
    pdf.getPage.mockRejectedValueOnce(new Error('broken page'))
    pdfMock.getDocumentProxy.mockResolvedValueOnce(pdf)
    expect(await attachmentText(input('doc.pdf', new Uint8Array([1])))).toBeUndefined()
    expect(pdf.cleanup).toHaveBeenCalledOnce()

    const cleanupFails = fakePdf(1, () => 'x')
    cleanupFails.cleanup.mockRejectedValueOnce(new Error('cleanup'))
    pdfMock.getDocumentProxy.mockResolvedValueOnce(cleanupFails)
    expect(await attachmentText(input('doc.pdf', new Uint8Array([1])))).toBeUndefined()
  })

  it('声明的 application/pdf 也按 PDF 解析', async () => {
    pdfMock.getDocumentProxy.mockResolvedValueOnce(fakePdf(1, () => 'x'))
    expect(await attachmentText(input('blob', new Uint8Array([1]), 'application/pdf'))).toBe('x')
  })
})

describe('attachmentText: Excel', () => {
  const workbook = {
    'xl/workbook.xml':
      '<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/>' +
      '<sheet name="Other" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml':
      '<sst><si><t>Name</t></si><si><r><t>He</t></r><r><t>llo</t></r></si>' +
      '<si><t>a &amp; b</t></si></sst>',
    'xl/styles.xml':
      '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>' +
      '<numFmt numFmtId="165" formatCode="0.00"/></numFmts><cellXfs>' +
      '<xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/>' +
      '<xf numFmtId="46"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>' +
      '<c r="C1" t="inlineStr"><is><t>Inline</t></is></c></row>' +
      '<row r="2"><c r="A2"><v>42</v></c><c r="B2" s="1"><v>45292</v></c>' +
      '<c r="C2" t="b"><v>1</v></c><c r="D2" t="e"><v>#DIV/0!</v></c></row>' +
      '<row r="3"><c r="A3" s="2"><v>45292</v></c><c r="B3" s="4"><v>45292.5</v></c>' +
      '<c r="C3" s="3"><v>3.5</v></c></row>' +
      '<row r="4"><c r="A4"/></row>' +
      '<row r="5"><c r="A5" t="str"><v>strval</v></c><c r="B5" t="s"><v>2</v></c></row>' +
      '<row r="6"><c r="A6"><v>1</v></c><c r="BI6"><v>9</v></c></row>' +
      '</sheetData></worksheet>',
    'xl/worksheets/sheet2.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>',
  }

  it('逐表输出缓存值、共享字符串与日期', async () => {
    const text = await attachmentText(input('book.xlsx', zip(workbook), 'application/octet-stream'))
    expect(text).toBe(
      [
        '## Data',
        'Name\tHello\tInline',
        '42\t2024-01-01\tTRUE\t#DIV/0!',
        '2024-01-01\t2024-01-01 12:00:00\t3.5',
        'strval\ta & b',
        '1',
        '',
        '## Other',
        'Name',
      ].join('\n'),
    )
  })

  it('超过行数上限时标注省略', async () => {
    const rows = Array.from(
      { length: 202 },
      (_, index) => `<row r="${index + 1}"><c r="A${index + 1}"><v>${index}</v></c></row>`,
    ).join('')
    const text = await attachmentText(
      input(
        'big.xlsx',
        zip({ ...workbook, 'xl/worksheets/sheet1.xml': `<sheetData>${rows}</sheetData>` }),
      ),
    )
    expect(text).toContain('[More rows omitted]')
    expect(text?.split('\n').filter((line) => /^\d+$/.test(line))).toHaveLength(200)
  })

  it('最多读 8 个工作表', async () => {
    const sheets = Array.from({ length: 10 }, (_, index) => index + 1)
    const files: Record<string, string> = {
      'xl/workbook.xml':
        '<workbook><sheets>' +
        sheets
          .map((number) => `<sheet name="S${number}" sheetId="${number}" r:id="rId${number}"/>`)
          .join('') +
        '</sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<Relationships>' +
        sheets
          .map(
            (number) => `<Relationship Id="rId${number}" Target="worksheets/sheet${number}.xml"/>`,
          )
          .join('') +
        '</Relationships>',
    }
    for (const number of sheets) {
      files[`xl/worksheets/sheet${number}.xml`] =
        `<sheetData><row r="1"><c r="A1"><v>${number}</v></c></row></sheetData>`
    }
    const text = await attachmentText(input('many.xlsx', zip(files)))
    expect(text).toContain('## S8')
    expect(text).not.toContain('## S9')
    expect(text).not.toContain('## S10')
  })

  it('缺少工作簿、损坏的压缩包或空表时返回 undefined', async () => {
    expect(
      await attachmentText(input('no-workbook.xlsx', zip({ 'xl/styles.xml': '<x/>' }))),
    ).toBeUndefined()
    expect(await attachmentText(input('broken.xlsx', new Uint8Array([1, 2, 3])))).toBeUndefined()
    expect(
      await attachmentText(
        input(
          'empty.xlsx',
          zip({
            'xl/workbook.xml':
              '<workbook><sheets><sheet name="A" r:id="rId1"/></sheets></workbook>',
            'xl/_rels/workbook.xml.rels':
              '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
            'xl/worksheets/sheet1.xml': '<sheetData><row r="1"><c r="A1"/></row></sheetData>',
          }),
        ),
      ),
    ).toBeUndefined()
  })

  it('按声明类型识别 Excel', async () => {
    const text = await attachmentText(
      input(
        'book.bin',
        zip(workbook),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    )
    expect(text).toContain('## Data')
  })

  it('边界：缺工作表、坏样式、错位单元格与实体转义', async () => {
    const files = {
      'xl/workbook.xml':
        '<workbook><sheets>' +
        '<sheet name="A" sheetId="1" r:id="rId1"/>' +
        '<sheet sheetId="2" r:id="rId2"/>' +
        '<sheet name="C" sheetId="3" r:id="rId3"/>' +
        '</sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<Relationships>' +
        '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>' +
        '<Relationship Id="rId3" Target="worksheets/missing.xml"/>' +
        '</Relationships>',
      'xl/sharedStrings.xml':
        '<sst><si><t>&lt;x&gt;&quot;y&quot;&apos;z&apos; &#65;&#x42; &#x110000;</t></si></sst>',
      'xl/styles.xml':
        '<styleSheet><numFmts><numFmt numFmtId="164"/><numFmt numFmtId="165" formatCode="0.00"/>' +
        '</numFmts><cellXfs><xf numFmtId="14"/><xf/><xf numFmtId="14"/>' +
        '</cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml':
        '<sheetData>' +
        '<row r="1"><c t="s"><v>0</v></c><c r="C1" t="b"><v>0</v></c><c r="D1" t="s"><v>99</v></c></row>' +
        '<row r="2"><c r="A2" s="1"><v>-1</v></c><c r="B2" s="2"><v>1e20</v></c></row>' +
        '<row r="3"><c r="7"><v>8</v></c></row>' +
        '</sheetData>',
      'xl/worksheets/sheet2.xml': '<sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData>',
    }
    const text = await attachmentText(input('edge.xlsx', zip(files)))
    expect(text).toBe(
      ['## A', `<x>"y"'z' AB &#x110000;\t\tFALSE\t`, '-1\t1e20', '8', '', '## Sheet2', '7'].join(
        '\n',
      ),
    )
  })

  it('工作簿没有 rels 或关系缺字段时，找不到的表直接跳过', async () => {
    const noRels = {
      'xl/workbook.xml':
        '<workbook><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>',
    }
    expect(await attachmentText(input('no-rels.xlsx', zip(noRels)))).toBeUndefined()

    const brokenRels = {
      ...noRels,
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship/></Relationships>',
      'xl/worksheets/sheet1.xml': '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>',
    }
    expect(await attachmentText(input('broken-rels.xlsx', zip(brokenRels)))).toBeUndefined()
  })

  it('解压时跳过声明异常大的条目（压缩炸弹防护）', async () => {
    const files = {
      'xl/workbook.xml':
        '<workbook><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>shared</t></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Inline</t></is></c></row></sheetData>',
    }
    // 单个条目超过上限：跳过它，其余照常解析。
    const bombed = fakeUncompressedSize(zip(files), 'xl/sharedStrings.xml', 17 * 1024 * 1024)
    const text = await attachmentText(input('bomb.xlsx', bombed))
    expect(text).toBe('## A\nInline')

    // 两个条目加起来超过总量上限：第二个被跳过，没有可读的表。
    const overBudget = fakeUncompressedSize(bombed, 'xl/worksheets/sheet1.xml', 60 * 1024 * 1024)
    expect(await attachmentText(input('budget.xlsx', overBudget))).toBeUndefined()
  })
})

describe('attachmentText: Word / PowerPoint', () => {
  it('抽取 Word 段落、制表符、换行与表格', async () => {
    const text = await attachmentText(
      input(
        'doc.docx',
        zip({
          'word/document.xml':
            '<w:document><w:body>' +
            '<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:tab/><w:t>world</w:t></w:r></w:p>' +
            '<w:p><w:r><w:t>Line</w:t><w:br/><w:t>two</w:t></w:r></w:p>' +
            '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc>' +
            '<w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
            '</w:body></w:document>',
        }),
      ),
    )
    expect(text).toBe('Hello\tworld\nLine\ntwo\na\n\tb')
  })

  it('Word 没有 document.xml 时返回 undefined', async () => {
    expect(await attachmentText(input('doc.docx', zip({ 'x.xml': '<x/>' })))).toBeUndefined()
  })

  it('按幻灯片编号排序并跳过空页', async () => {
    const slide = (text: string) =>
      `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p>` +
      `</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
    const text = await attachmentText(
      input(
        'deck.pptx',
        zip({
          'ppt/slides/slide10.xml': slide('Ten'),
          'ppt/slides/slide2.xml': slide('Two'),
          'ppt/slides/slide1.xml': slide('One'),
          'ppt/slides/slide3.xml': '<p:sld/>',
          'ppt/slides/notes.xml': slide('Not a slide'),
        }),
      ),
    )
    expect(text).toBe('## Slide 1\nOne\n\n## Slide 2\nTwo\n\n## Slide 10\nTen')
  })

  it('PowerPoint 没有幻灯片时返回 undefined', async () => {
    expect(await attachmentText(input('deck.pptx', zip({ 'x.xml': '<x/>' })))).toBeUndefined()
  })
})
