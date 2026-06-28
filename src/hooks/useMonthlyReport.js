// src/hooks/useMonthlyReport.js
// Tạo báo cáo (Word) theo đúng MẪU CHUẨN VATM (file "Báo cáo phục vụ đầu tư -
// gửi ban KHĐT") — AI đọc toàn văn các văn bản trong dự án, tự điền vào cấu
// trúc mẫu, xuất file .docx tải về trực tiếp từ trình duyệt (không qua server).
import { useState } from 'react'
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, BorderStyle, WidthType, Header, PageNumber,
} from 'docx'

// Trích đúng khối JSON {...} từ phản hồi AI.
// Cách cũ chỉ strip dấu ```json — nếu AI lỡ thêm 1 câu dẫn/giải thích trước hoặc
// sau JSON (hay gặp hơn khi rơi xuống Groq/OpenRouter fallback, tuân lệnh "chỉ
// trả JSON" kém nghiêm hơn Gemini) thì JSON.parse() fail ngay dù JSON bên trong
// vẫn hợp lệ. Lấy đúng từ dấu "{" đầu tới "}" cuối thì vẫn parse được.
const extractJson = (raw) => {
  if (!raw) return null
  const noFence = raw.replace(/```json|```/g, '').trim()
  const start = noFence.indexOf('{')
  const end = noFence.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try { return JSON.parse(noFence.slice(start, end + 1)) } catch { return null }
}

const buildReportPrompt = (projectName, fullCtx) => `Bạn là trợ lý lập báo cáo dự án. Dựa trên TOÀN VĂN các văn bản dưới đây, hãy điền vào đúng cấu trúc báo cáo theo mẫu chuẩn của Tổng công ty Quản lý bay Việt Nam (theo Công văn 7023/QLB-KHĐT ngày 8/10/2025).

CHỈ trả về JSON hợp lệ, KHÔNG kèm dấu \`\`\`, KHÔNG viết bất kỳ câu dẫn hay giải thích nào trước hoặc sau JSON. Các đoạn tường thuật ("tinhHinhChuanBiDauTu", "tinhHinhTrienKhai") viết theo mốc thời gian cụ thể (ngày/tháng/năm) lấy đúng từ văn bản, súc tích — ưu tiên các mốc quan trọng nhất, không cần kể lại từng chi tiết nhỏ, để JSON không bị cắt cụt giữa chuỗi. Đúng cấu trúc:

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
  "tinhHinhTrienKhai": "đoạn văn tường thuật theo mốc thời gian cụ thể, súc tích",
  "khoKhanVuongMac": "nêu khó khăn/vướng mắc/kiến nghị nếu văn bản có nhắc tới, không có thì để chuỗi rỗng"
}

Dự án: ${projectName}

NỘI DUNG VĂN BẢN:
${fullCtx}`

export function useMonthlyReport() {
  const [generating, setGenerating] = useState(false)

  // askRaw: hàm gọi AI sạch (không qua system prompt mặc định) — truyền vào từ
  // useAI() ở component cha, để dùng chung 1 nguồn key/quota với phần còn lại.
  const generateReport = async ({ projectName, fullCtx, askRaw }) => {
    setGenerating(true)
    try {
      const prompt = buildReportPrompt(projectName, fullCtx)

      // maxTokens=8000 (trước đây 3000 hay bị cắt cụt giữa chuỗi JSON với báo
      // cáo nhiều trường tường thuật dài) + thử tối đa 2 lần (đề phòng 1 lượt
      // rơi xuống provider fallback trả JSON lệch format).
      let data = null
      let lastRaw = ''
      for (let attempt = 0; attempt < 2 && !data; attempt++) {
        lastRaw = await askRaw(prompt, 8000)
        data = extractJson(lastRaw)
      }

      if (!data) {
        console.error(
          '[useMonthlyReport] AI không trả JSON hợp lệ sau 2 lần thử. Độ dài phản hồi cuối:',
          lastRaw?.length || 0,
          '\n200 ký tự cuối phản hồi:', lastRaw?.slice(-200)
        )
        throw new Error('AI trả về không đúng định dạng JSON sau 2 lần thử. Thử lại sau, hoặc thu hẹp phạm vi (chọn 1 gói thầu cụ thể thay vì cả dự án) nếu dự án có nhiều văn bản dài.')
      }

      await buildAndDownloadDocx(data, projectName)
    } finally {
      setGenerating(false)
    }
  }

  return { generateReport, generating }
}

// ── Layout dưới đây đã đối chiếu trực tiếp với file MẪU CHUẨN Tony cung cấp
// ("Báo cáo phục vụ đầu tư - gửi ban KHĐT.doc"):
//   - Khổ A4 chuẩn (11906x16838 DXA), margin top/right/bottom=1134 (2cm),
//     left=1701 (3cm)
//   - Font Times New Roman; quốc hiệu/tiêu ngữ (header) cỡ 12pt (24); thân và
//     tiêu đề cỡ 14pt (28)
//   - Tiêu đề là "BÁO CÁO" + "V/v: ..." (KHÔNG phải "BÁO CÁO THÁNG MM NĂM YYYY"
//     như bản trước)
//   - "1. Tình hình chuẩn bị đầu tư:" in đậm + nghiêng, nội dung "triển khai"
//     nối liền ngay dưới, KHÔNG tách riêng mục "2."
//   - Có số trang (giữa, từ trang 2) — trang 1 không hiện số trang
// Đã build thử bằng chính thư viện docx + LibreOffice render ảnh so khớp từng
// dòng với mẫu trước khi giao.
async function buildAndDownloadDocx(data, projectName) {
  const now = new Date()
  const thang = now.getMonth() + 1 // lấy đúng tháng/năm tại THỜI ĐIỂM bấm nút
  const nam = now.getFullYear()

  const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }
  const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder, insideHorizontal: noBorder, insideVertical: noBorder }
  const FS = 28  // 14pt — thân báo cáo, tiêu đề
  const HFS = 24 // 12pt — quốc hiệu/tiêu ngữ (đúng mẫu chuẩn)

  // Gạch ngắn trang trí dưới dòng 2 mỗi cột header — xấp xỉ lại đường line gốc
  // (vốn là 1 shape vẽ tay trong mẫu, không phải border) bằng 1 đoạn rỗng có
  // border dưới, thu hẹp 2 bên qua indent để không kéo dài hết cột.
  const shortUnderline = (colWidth) => new Paragraph({
    indent: { left: Math.round(colWidth * 0.27), right: Math.round(colWidth * 0.27) },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000', space: 1 } },
    children: [new TextRun(' ')],
  })

  const twoColHeader = () => new Table({
    width: { size: 9072, type: WidthType.DXA },
    columnWidths: [4536, 4536],
    borders: noBorders,
    rows: [new TableRow({ children: [
      new TableCell({
        width: { size: 4536, type: WidthType.DXA },
        margins: { top: 0, bottom: 0, left: 0, right: 60 },
        children: [
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'TỔNG CÔNG TY QUẢN LÝ BAY VIỆT NAM', size: HFS })] }),
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'BQL DỰ ÁN CHUYÊN NGÀNH QUẢN LÝ BAY', bold: true, size: HFS })] }),
          shortUnderline(4536),
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 60 }, children: [new TextRun({ text: 'Số:        /BC-QLDA', size: HFS })] }),
        ],
      }),
      new TableCell({
        width: { size: 4536, type: WidthType.DXA },
        margins: { top: 0, bottom: 0, left: 60, right: 0 },
        children: [
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'CỘNG HOÀ XÃ HỘI CHỦ NGHĨA VIỆT NAM', bold: true, size: HFS })] }),
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Độc lập - Tự do - Hạnh phúc', bold: true, size: HFS })] }),
          shortUnderline(4536),
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 60 }, children: [new TextRun({ text: `Hà Nội, ngày ${now.getDate()} tháng ${thang} năm ${nam}`, italics: true, size: HFS })] }),
        ],
      }),
    ] })],
  })

  // Đoạn thân chuẩn: thụt đầu dòng 567 DXA (~1cm) + 2 lề đều (justify).
  const bodyPara = (text, opts = {}) => new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    indent: { firstLine: 567 },
    spacing: { before: 120, after: 120 },
    children: [new TextRun({ text, size: FS, ...opts })],
  })

  // Mục 1-8 "Thông tin chung dự án": label hoa đậm + indent hanging (851/284).
  const infoLine = (num, label, value) => new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    indent: { left: 851, hanging: 284 },
    spacing: { before: 120, after: 120 },
    children: [
      new TextRun({ text: `${num}. ${label}: `, bold: true, size: FS }),
      new TextRun({ text: value || 'Chưa có thông tin', size: FS }),
    ],
  })

  const children = [
    twoColHeader(),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 120 }, children: [new TextRun({ text: ' ', bold: true, size: FS })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 120 }, children: [new TextRun({ text: 'BÁO CÁO', bold: true, size: FS })] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [
        new TextRun({ text: 'V/v: ', bold: true, size: FS }),
        new TextRun({ text: 'Tình hình thực hiện dự án ', size: FS }),
        new TextRun({ text: `\u201C${data.tenDuAn || projectName}\u201D`, bold: true, size: FS }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [new TextRun({ text: 'Kính gửi: Ban Kế hoạch – Đầu tư', size: FS })],
    }),
    bodyPara('Căn cứ Công văn số 7023/QLB-KHĐT ngày 8/10/2025 của Tổng công ty về việc áp dụng mẫu báo cáo đánh giá tình hình triển khai các dự án/gói thầu phục vụ hội nghị giao ban về công tác kế hoạch, đầu tư;'),
    bodyPara(`Ban Quản lý dự án chuyên ngành Quản lý bay (QLDA) báo cáo tình hình thực hiện dự án \u201C${data.tenDuAn || projectName}\u201D đến nay như sau:`),
    new Paragraph({ spacing: { before: 120, after: 120 }, children: [new TextRun({ text: 'I. Thông tin chung dự án', bold: true, size: FS })] }),
    infoLine(1, 'Tên dự án', data.tenDuAn),
    infoLine(2, 'Tổng mức đầu tư', data.tongMucDauTu),
    infoLine(3, 'Người quyết định đầu tư', data.nguoiQuyetDinhDauTu),
    infoLine(4, 'Chủ đầu tư', data.chuDauTu),
    infoLine(5, 'Hình thức tổ chức quản lý dự án được áp dụng', data.hinhThucToChucQuanLy),
    infoLine(6, 'Nguồn vốn', data.nguonVon),
    infoLine(7, 'Thời gian thực hiện dự án', data.thoiGianThucHien),
  ]

  if (data.mucTieuDauTu?.length) {
    children.push(new Paragraph({
      indent: { left: 851, hanging: 284 },
      spacing: { before: 120, after: 120 },
      children: [new TextRun({ text: '8. Mục tiêu đầu tư:', bold: true, size: FS })],
    }))
    data.mucTieuDauTu.forEach(m => children.push(bodyPara(`- ${m}`)))
  }

  // "II. Tình hình thực hiện" → "1. Tình hình chuẩn bị đầu tư:" (đậm+nghiêng)
  // → nội dung chuẩn bị đầu tư, RỒI nối liền nội dung triển khai ngay dưới,
  // KHÔNG tách thành mục "2." riêng — đúng cấu trúc mẫu chuẩn.
  children.push(
    new Paragraph({ spacing: { before: 120, after: 120 }, children: [new TextRun({ text: 'II. Tình hình thực hiện', bold: true, size: FS })] }),
    bodyPara('1. Tình hình chuẩn bị đầu tư: ', { bold: true, italics: true }),
    bodyPara(data.tinhHinhChuanBiDauTu || 'Chưa có thông tin'),
    bodyPara(data.tinhHinhTrienKhai || 'Chưa có thông tin'),
  )

  if (data.khoKhanVuongMac) {
    children.push(
      new Paragraph({ spacing: { before: 120, after: 60 }, children: [new TextRun({ text: 'III. Khó khăn, vướng mắc, kiến nghị:', bold: true, italics: true, size: FS })] }),
      bodyPara(`- ${data.khoKhanVuongMac}`),
    )
  }

  children.push(new Paragraph({
    indent: { firstLine: 851 },
    spacing: { before: 200, after: 200 },
    children: [new TextRun({ text: 'Kính báo cáo!', italics: true, size: FS })],
  }))

  const sigTable = new Table({
    width: { size: 9039, type: WidthType.DXA },
    columnWidths: [4248, 4791],
    borders: noBorders,
    rows: [new TableRow({ children: [
      new TableCell({
        width: { size: 4248, type: WidthType.DXA },
        children: [
          new Paragraph({ children: [new TextRun({ text: 'Nơi nhận:', bold: true, italics: true, size: FS })] }),
          new Paragraph({ children: [new TextRun({ text: '- Như trên;', size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: '- Lưu: VT, Tổ dự án.', size: 22 })] }),
        ],
      }),
      new TableCell({
        width: { size: 4791, type: WidthType.DXA },
        children: [
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'GIÁM ĐỐC', bold: true, size: FS })] }),
        ],
      }),
    ] })],
  })
  children.push(sigTable)

  const doc = new Document({
    styles: { default: { document: { run: { font: 'Times New Roman', size: FS } } } },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 }, // A4 chuẩn
          margin: { top: 1134, right: 1134, bottom: 1134, left: 1701 }, // 2cm/2cm/2cm/3cm — đúng mẫu chuẩn
        },
        titlePage: true, // trang 1 KHÔNG hiện số trang, đúng mẫu
      },
      headers: {
        default: new Header({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], size: 22 })] })] }),
        first: new Header({ children: [new Paragraph({ children: [new TextRun(' ')] })] }),
      },
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
