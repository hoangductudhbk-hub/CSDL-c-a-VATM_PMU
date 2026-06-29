// src/hooks/useResearch.js
// "Tra cứu tổng hợp" — nâng Trợ lý AI lên xử lý ĐA BƯỚC cho câu hỏi phức tạp,
// thay vì luôn hỏi-đáp 1 lượt như trước (Trợ lý AI cũ chỉ nhồi hết văn bản
// vào 1 prompt rồi hỏi 1 câu — dễ bỏ sót khi câu hỏi cần so sánh/tổng hợp
// nhiều khía cạnh, nhiều văn bản).
//
// Quy trình:
//   1) PHÂN LOẠI: AI đọc câu hỏi + văn bản, tự quyết định:
//      - ĐƠN GIẢN → trả lời thẳng luôn (vẫn chỉ 1 lượt gọi AI, không tốn
//        thêm quota so với trước).
//      - PHỨC TẠP → tách thành 2-4 câu hỏi phụ, mỗi câu 1 khía cạnh cụ thể.
//   2) TRA CỨU RIÊNG từng câu hỏi phụ — chạy SONG SONG (Promise.all) để không
//      chậm hơn nhiều so với hỏi 1 lượt.
//   3) TỔNG HỢP các câu trả lời phụ thành 1 câu trả lời mạch lạc, ĐỒNG THỜI
//      tự đối chiếu lại với đúng nội dung văn bản gốc (chống bịa/sai số liệu —
//      lỗi đã gặp thực tế ở Báo cáo đầu tư) — gộp vào CÙNG 1 lượt gọi AI cuối,
//      không cần thêm round-trip riêng cho bước kiểm tra.
import { useState } from 'react'

const extractJson = (raw) => {
  if (!raw) return null
  const noFence = raw.replace(/```json|```/g, '').trim()
  const start = noFence.indexOf('{')
  const end = noFence.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try { return JSON.parse(noFence.slice(start, end + 1)) } catch { return null }
}

const triagePrompt = (q, ctx) => `Bạn là trợ lý tra cứu thông minh cho hệ thống quản lý văn bản dự án. Đọc câu hỏi sau và NỘI DUNG VĂN BẢN bên dưới.

CÂU HỎI: "${q}"

Xác định:
- Nếu câu hỏi ĐƠN GIẢN (hỏi đúng 1 thông tin cụ thể, có thể trả lời trực tiếp, đầy đủ ngay từ nội dung văn bản) → TRẢ LỜI NGAY bằng văn xuôi thông thường, đầy đủ, đúng theo nội dung gốc, không bịa nếu không thấy thông tin. KHÔNG dùng JSON cho trường hợp này.
- Nếu câu hỏi PHỨC TẠP (cần so sánh/tổng hợp nhiều văn bản, nhiều khía cạnh, hoặc suy luận nhiều bước mới ra được câu trả lời đầy đủ) → CHỈ trả về JSON (không kèm chữ nào khác, không kèm \`\`\`): {"complex": true, "subQuestions": ["câu hỏi phụ 1 cụ thể", "câu hỏi phụ 2", "..."]} — tối đa 4 câu hỏi phụ, mỗi câu tập trung đúng 1 khía cạnh cần tra cứu riêng để gộp lại trả lời đầy đủ câu hỏi gốc.

NỘI DUNG VĂN BẢN:
${ctx}`

const subQuestionPrompt = (subQ, ctx) => `Dựa vào ĐÚNG nội dung văn bản dưới đây, trả lời câu hỏi sau một cách đầy đủ, chính xác. Nếu văn bản không có thông tin này, nói rõ "Không tìm thấy thông tin này trong văn bản" — không suy đoán.

CÂU HỎI: "${subQ}"

NỘI DUNG VĂN BẢN:
${ctx}`

const synthesizePrompt = (q, subAnswers, ctx) => `Câu hỏi gốc của người dùng: "${q}"

Dưới đây là các phần đã tra cứu riêng cho từng khía cạnh của câu hỏi:
${subAnswers.map((a, i) => `--- Khía cạnh ${i + 1} ---\n${a}`).join('\n\n')}

Hãy TỔNG HỢP các phần trên thành 1 câu trả lời ĐẦY ĐỦ, MẠCH LẠC, viết liền mạch tự nhiên (không liệt kê lại "khía cạnh 1/2/3"), đúng trọng tâm câu hỏi gốc.

QUAN TRỌNG — trước khi trả lời, ĐỐI CHIẾU lại từng số liệu/ngày/tên/số hiệu văn bản trong các phần trên với ĐÚNG NỘI DUNG VĂN BẢN GỐC dưới đây — nếu phát hiện chi tiết nào KHÔNG có trong văn bản gốc hoặc bị sai, SỬA LẠI cho đúng hoặc bỏ chi tiết đó, KHÔNG suy đoán thêm.

NỘI DUNG VĂN BẢN GỐC:
${ctx}`

export function useResearch() {
  const [researching, setResearching] = useState(false)

  // askRaw: hàm gọi AI sạch từ useAI() ở component cha (dùng chung quota/key
  // với phần còn lại của app — Gemini trước, Groq/OpenRouter dự phòng).
  const researchAsk = async (q, ctx, askRaw) => {
    setResearching(true)
    try {
      const triageRaw = await askRaw(triagePrompt(q, ctx), 2500)
      const triageJson = extractJson(triageRaw)

      // Không parse được JSON → AI đã trả lời thẳng (câu hỏi đơn giản) → dùng luôn,
      // chỉ tốn đúng 1 lượt gọi AI như cách cũ.
      if (!triageJson || !triageJson.complex || !triageJson.subQuestions?.length) {
        return triageRaw
      }

      // Câu hỏi phức tạp → tra cứu riêng từng câu hỏi phụ, CHẠY SONG SONG.
      const subQuestions = triageJson.subQuestions.slice(0, 4)
      const subAnswers = await Promise.all(
        subQuestions.map(sq => askRaw(subQuestionPrompt(sq, ctx), 2000).catch(() => 'Lỗi tra cứu khía cạnh này, bỏ qua.'))
      )

      // Tổng hợp + tự đối chiếu lại nguồn trong CÙNG 1 lượt gọi cuối.
      const finalAnswer = await askRaw(synthesizePrompt(q, subAnswers, ctx), 3000)
      return finalAnswer || subAnswers.join('\n\n')
    } finally {
      setResearching(false)
    }
  }

  return { researchAsk, researching }
}
