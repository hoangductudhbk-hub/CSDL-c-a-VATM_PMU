// src/hooks/useMonthlyReport.js
// Tạo báo cáo tháng (Word) theo đúng mẫu chuẩn VATM (Công văn 7023/QLB-KHĐT) —
// AI đọc toàn văn các văn bản trong dự án, tự điền vào cấu trúc mẫu, xuất file
// .docx tải về trực tiếp từ trình duyệt (không qua server).
import { useState } from 'react'
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, BorderStyle, WidthType, LevelFormat,
} from 'docx'

export function useMonthlyReport() {
  const [generating, setGenerating] = useState(false)

  // askRaw: hàm gọi AI sạch (không qua system prompt mặc định) — truyền vào từ
  // useAI() ở component cha, để dùng chung 1 nguồn key/quota với phần còn lại.
  const generateReport = async ({ projectName, fullCtx, askRaw }) => {
    setGenerating(true)
    try {
      const prompt = `Bạn là trợ lý lập báo cáo dự án. Dựa trên TOÀN VĂN các văn bản dưới đây, hãy điền vào đúng cấu trúc báo cáo tháng theo mẫu chuẩn của Tổng công ty Quản lý bay Việt Nam (theo Công văn 7023/QLB-KHĐT ngày 8/10/2025).

CHỈ trả về JSON hợp lệ, KHÔNG kèm dấu \`\`\`, KHÔNG giải thích gì thêm ngoài JSON. Đúng cấu trúc:

{
  "tenDuAn": "tên đầy đủ dự án",
  "tongMucDauTu": "số tiền + VNĐ, lấy từ Quyết định phê duyệt dự án — nếu văn bản không có ghi 'Chưa có thông tin'",
  "nguoiQuyetDinhDauTu": "...",
  "chuDauTu": "...",
  "hinhThucToChucQuanLy": "...",
  "nguonVon": "...",
  "thoiGianThucHien": "...",
  "mucTieuDauTu": ["điểm 1", "điểm 2"] hoặc null nếu văn bản không nêu mục tiêu rõ ràng,
  "tinhHinhChuanBiDauTu": "đoạn văn tường thuật ngắn",
  "tinhHinhTrienKhai": "đoạn văn tường thuật CHI TIẾT theo mốc thời gian cụ thể (ngày/tháng/năm) lấy đúng từ văn bản, không suy đoán thêm",
  "khoKhanVuongMac": "nêu khó khăn/vướng mắc/kiến nghị nếu văn bản có nhắc tới, không có thì để chuỗi rỗng"
}

Dự án: ${projectName}

NỘI DUNG VĂN BẢN:
${fullCtx}`

      const raw = await askRaw(prompt, 3000)
      const cleaned = raw.replace(/```json|```/g, '').trim()
      let data
      try { data = JSON.parse(cleaned) }
      catch { throw new Error('AI trả về không đúng định dạng JSON, thử lại sau.') }

      await buildAndDownloadDocx(data, projectName)
    } finally {
      setGenerating(false)
    }
  }

  return { generateReport, generating }
}

async function buildAndDownloadDocx(data, projectName) {
  const now = new Date()
  const thang = now.getMonth() + 1
  const nam = now.getFullYear()

  const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }
  const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder, insideHorizontal: noBorder, insideVertical: noBorder }

  // 2 cột dùng bảng không viền — ổn định hơn tab stop khi dòng chữ dài (đã kiểm
  // chứng thực tế: tab stop bị dính chữ khi văn bản bên trái quá dài).
  const twoColTable = (leftLines, rightLines, rightAlign = AlignmentType.CENTER) => new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [4680, 4680],
    borders: noBorders,
    rows: [new TableRow({ children: [
      new TableCell({ width: { size: 4680, type: WidthType.DXA }, margins: { top: 0, bottom: 0, left: 0, right: 60 }, children: leftLines.map(t => new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: t, bold: true })] })) }),
      new TableCell({ width: { size: 4680, type: WidthType.DXA }, margins: { top: 0, bottom: 0, left: 60, right: 0 }, children: rightLines.map(t => new Paragraph({ alignment: rightAlign, children: [new TextRun({ text: t, bold: true })] })) }),
    ] })],
  })

  const infoLine = (num, label, value) => new Paragraph({
    children: [
      new TextRun({ text: `${num}. ${label}: `, bold: true }),
      new TextRun({ text: value || 'Chưa có thông tin' }),
    ],
    spacing: { after: 120 },
  })

  const children = [
    twoColTable(
      ['TỔNG CÔNG TY QUẢN LÝ BAY VIỆT NAM', 'BQL DỰ ÁN CHUYÊN NGÀNH QUẢN LÝ BAY'],
      ['CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', 'Độc lập - Tự do - Hạnh phúc'],
    ),
    new Paragraph({
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 1 } },
      children: [new TextRun(' ')],
      spacing: { after: 120 },
    }),
    twoColTable([''], [`Hà Nội, ngày ${now.getDate()} tháng ${thang} năm ${nam}`]),
    new Paragraph({ text: '', spacing: { after: 200 } }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `BÁO CÁO THÁNG ${String(thang).padStart(2, '0')} NĂM ${nam}`, bold: true, size: 28 })],
      spacing: { after: 120 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `Tình hình thực hiện dự án "${data.tenDuAn || projectName}"`, bold: true, italics: true })],
      spacing: { after: 240 },
    }),
    new Paragraph({ children: [new TextRun({ text: 'Kính gửi: Ban Kế hoạch – Đầu tư', bold: true })], spacing: { after: 200 } }),
    new Paragraph({
      children: [new TextRun('Căn cứ Công văn số 7023/QLB-KHĐT ngày 8/10/2025 của Tổng công ty về việc áp dụng mẫu báo cáo đánh giá tình hình triển khai các dự án/gói thầu phục vụ hội nghị giao ban về công tác kế hoạch, đầu tư;')],
      spacing: { after: 120 },
    }),
    new Paragraph({
      children: [new TextRun(`Ban Quản lý dự án chuyên ngành Quản lý bay (QLDA) báo cáo tình hình thực hiện dự án "${data.tenDuAn || projectName}" đến nay như sau:`)],
      spacing: { after: 240 },
    }),
    new Paragraph({ children: [new TextRun({ text: 'I. Thông tin chung dự án', bold: true })], spacing: { after: 160 } }),
    infoLine(1, 'Tên dự án', data.tenDuAn),
    infoLine(2, 'Tổng mức đầu tư', data.tongMucDauTu),
    infoLine(3, 'Người quyết định đầu tư', data.nguoiQuyetDinhDauTu),
    infoLine(4, 'Chủ đầu tư', data.chuDauTu),
    infoLine(5, 'Hình thức tổ chức quản lý dự án được áp dụng', data.hinhThucToChucQuanLy),
    infoLine(6, 'Nguồn vốn', data.nguonVon),
    infoLine(7, 'Thời gian thực hiện dự án', data.thoiGianThucHien),
  ]

  if (data.mucTieuDauTu?.length) {
    children.push(new Paragraph({ children: [new TextRun({ text: '8. Mục tiêu đầu tư:', bold: true })], spacing: { after: 80 } }))
    data.mucTieuDauTu.forEach(m => {
      children.push(new Paragraph({
        numbering: { reference: 'bullets', level: 0 },
        children: [new TextRun(m)],
        spacing: { after: 80 },
      }))
    })
  }

  children.push(
    new Paragraph({ children: [new TextRun({ text: 'II. Tình hình thực hiện', bold: true })], spacing: { before: 240, after: 160 } }),
    new Paragraph({ children: [new TextRun({ text: '- Tình hình chuẩn bị đầu tư:', bold: true })], spacing: { after: 80 } }),
    new Paragraph({ children: [new TextRun(data.tinhHinhChuanBiDauTu || 'Chưa có thông tin')], spacing: { after: 200 } }),
    new Paragraph({ children: [new TextRun({ text: '- Tình hình triển khai:', bold: true })], spacing: { after: 80 } }),
    new Paragraph({ children: [new TextRun(data.tinhHinhTrienKhai || 'Chưa có thông tin')], spacing: { after: 200 } }),
  )

  if (data.khoKhanVuongMac) {
    children.push(
      new Paragraph({ children: [new TextRun({ text: 'Khó khăn, vướng mắc, kiến nghị:', bold: true })], spacing: { before: 120, after: 80 } }),
      new Paragraph({ children: [new TextRun(data.khoKhanVuongMac)], spacing: { after: 200 } }),
    )
  }

  children.push(new Paragraph({ children: [new TextRun({ text: 'Kính báo cáo!', bold: true })], spacing: { before: 240, after: 240 } }))

  const sigTable = new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [4680, 4680],
    borders: noBorders,
    rows: [new TableRow({ children: [
      new TableCell({
        width: { size: 4680, type: WidthType.DXA },
        children: [
          new Paragraph({ children: [new TextRun({ text: 'Nơi nhận:', italics: true })] }),
          new Paragraph({ children: [new TextRun('- Như trên;')] }),
          new Paragraph({ children: [new TextRun('- Lưu: VT, Tổ dự án.')] }),
        ],
      }),
      new TableCell({
        width: { size: 4680, type: WidthType.DXA },
        children: [
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'GIÁM ĐỐC', bold: true })] }),
        ],
      }),
    ] })],
  })
  children.push(sigTable)

  const doc = new Document({
    numbering: {
      config: [{ reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] }],
    },
    styles: { default: { document: { run: { font: 'Times New Roman', size: 26 } } } },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1080, bottom: 1440, left: 1440 } } },
      children,
    }],
  })

  const blob = await Packer.toBlob(doc)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `Bao_cao_thang_${thang}_${nam}_${(projectName || 'duan').replace(/[^a-zA-Z0-9À-ỹ]/g, '_')}.docx`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
