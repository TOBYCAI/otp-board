package com.example.otpforward.core

import java.text.Normalizer
import java.time.LocalTime
import java.time.format.DateTimeFormatter

/**
 * Extracts a one-time code + inferred platform from an arbitrary message body.
 *
 * This is the SINGLE source of extraction truth. It has NO Android dependency and
 * is mirrored 1:1 by `shared/js/otp-core.js` so the server can reuse the exact same
 * logic. Keep the two implementations in sync.
 *
 * Note: this extractor intentionally does NOT set `source` — the channel that
 * produced the message (SMS, WhatsApp, Email, …) is decided by the caller, not
 * by the text. That makes the extractor reusable for any ingestion path.
 */
object OtpExtractor {
    private val whitelist = listOf(
        "验证码", "验码", "校验码", "认证码", "确认码", "安全码", "登录码", "登陆码",
        "短信码", "动态码", "动态口令", "一次性密码", "一次性口令", "激活码",
        "code", "otp", "verification", "pin", "token", "verify",
        "verifying", "one-time", "one time", "security code", "authentication",
        "authenticate", "confirmation", "password", "passcode", "login", "sign-in",
        "sign in", "confirm", "secure", "weixin", "wechat", "linking",
    )

    private val blacklist = listOf(
        "促销", "优惠", "打折", "满减", "返利", "抽奖", "中奖", "领红包",
        "退订回复TD", "回复T", "回复N",
        "已发货", "取件码", "快递", "余额", "账单", "消费", "还款", "扣款",
    )

    private val carrierMap = mapOf(
        "10000" to "中国电信",
        "10010" to "中国联通",
        "10086" to "中国移动",
        "10099" to "中国广电",
        "95588" to "工商银行",
        "95533" to "建设银行",
        "95555" to "招商银行",
        "95566" to "中国银行",
        "95599" to "农业银行",
        "95528" to "浦发银行",
        "95561" to "兴业银行",
        "95568" to "民生银行",
        "95559" to "交通银行",
        "95558" to "中信银行",
        "95511" to "平安银行",
        "95577" to "华夏银行",
        "95508" to "广发银行",
        "95580" to "邮储银行",
    )

    private val timeFormatter = DateTimeFormatter.ofPattern("HH:mm:ss")

    private data class OtpCandidate(
        val value: String,
        val normalized: String,
        val start: Int,
        val end: Int,
        val kind: CandidateKind,
    )

    private enum class CandidateKind {
        NUMERIC,
        SEPARATED_NUMERIC,
        ALPHANUMERIC,
    }

    fun process(body: String, sender: String): Map<String, String>? {
        val normalizedBody = normalizeMessage(body)
        val otp = extractOtp(normalizedBody) ?: return null
        val platform = extractPlatform(normalizedBody, sender)

        return mapOf(
            "otp" to otp,
            "platform" to platform,
            "time" to LocalTime.now().format(timeFormatter),
        )
    }

    private fun extractOtp(body: String): String? {
        findDirectOtp(body)?.let { return it }

        val lower = body.lowercase()
        if (whitelist.none { lower.contains(it) }) return null

        val candidates = buildCandidates(body).distinctBy { "${it.normalized}:${it.start}" }
        if (candidates.isEmpty()) return null

        return candidates
            .map { it to scoreCandidate(body, it) }
            .filter { (candidate, score) ->
                val minimumScore = if (candidate.kind == CandidateKind.ALPHANUMERIC) 52 else 28
                score >= minimumScore
            }
            .maxWithOrNull(
                compareBy<Pair<OtpCandidate, Int>> { it.second }
                    .thenBy { if (it.first.normalized.length == 6) 1 else 0 }
                    .thenByDescending { it.first.start },
            )
            ?.first
            ?.let { candidate ->
                if (candidate.kind == CandidateKind.ALPHANUMERIC) candidate.value else candidate.normalized
            }
    }

    private fun normalizeMessage(body: String): String {
        return Normalizer.normalize(body, Normalizer.Form.NFKC)
            .replace('\u00A0', ' ')
            .replace('\u2007', ' ')
            .replace('\u202F', ' ')
            .replace(Regex("""[\u200B-\u200D\u2060\uFEFF]"""), "")
            .replace('’', '\'')
            .replace('“', '"')
            .replace('”', '"')
            .replace(Regex("""[\t\r\n]+"""), " ")
            .replace(Regex(""" {2,}"""), " ")
            .trim()
    }

    private fun findDirectOtp(body: String): String? {
        val directPatterns = listOf(
            Regex("""(?i)(?:weixin|wechat).{0,64}?(?:linking|verifying|verify).{0,32}?mobile\s+number\s*[\(（\[]\s*(\d{4,8})\s*[\)）\]]"""),
            Regex("""(?i)(?:linking|verifying|verification|verify|security\s+code|code).{0,48}?[\(（\[]\s*(\d{4,8})\s*[\)）\]]"""),
            Regex("""(?i)\b(?:verification\s+code|security\s+code|authentication\s+code|confirmation\s+code|one[ -]?time\s+(?:password|code)|otp(?:\s+code)?|passcode|pin)\s+[\(（\[]?\s*(\d{4,8})\b"""),
            Regex("""(?i)\b(?:your\s+)?(?:verification\s+code|security\s+code|authentication\s+code|confirmation\s+code|one[ -]?time\s+(?:password|code)|otp(?:\s+code)?|passcode|pin|token|code)\s*(?:is|=|:|：|-)\s*[\(（\[]?\s*([a-z0-9]{4,10}(?:-[a-z0-9]{2,5})?)\b"""),
            Regex("""(?i)\b([a-z0-9]{4,10}(?:-[a-z0-9]{2,5})?)\b\s*(?:is|=|:)\s*(?:your|the)\s+(?:[a-z0-9][a-z0-9 .,'_-]{0,32}\s+)?(?:verification\s+code|security\s+code|authentication\s+code|confirmation\s+code|one[ -]?time\s+(?:password|code)|otp(?:\s+code)?|passcode|pin|token|code)\b"""),
            Regex("""(?i)(?:your\s+)?(?:verification|authentication|security|confirmation|login|sign[ -]?in|one[ -]?time)?\s*(?:code|otp|pin|token|passcode)\s*(?:is|=|:|：|-)\s*[\(（\[]?\s*([a-z0-9]{4,10}(?:-[a-z0-9]{2,5})?)\b"""),
            Regex("""(?i)\b([a-z0-9]{4,10}(?:-[a-z0-9]{2,5})?)\b\s*(?:is|=|:)\s*(?:your|the)\s+(?:[a-z0-9][a-z0-9 .,'_-]{0,32}\s+)?(?:verification|authentication|security|confirmation|login|sign[ -]?in|one[ -]?time)?\s*(?:code|otp|pin|token|passcode)\b"""),
            Regex("""(?i)\b(?:use|enter|type|submit|input)\s+(?:the\s+)?(?:code\s+)?[\(（\[]?\s*((?:[a-z0-9]{4,10}|[a-z0-9]{2,5}-[a-z0-9]{2,5}))\b.{0,40}?\b(?:verify|verification|authenticate|confirm|login|sign[ -]?in|continue|proceed)\b"""),
            Regex("""(?i)\b(?:verify|verification|authenticate|confirm|login|sign[ -]?in).{0,32}?\b(?:with|using|code|otp|pin)\s*(?:is|=|:|：|-)?\s*[\(（\[]?\s*([a-z0-9]{4,10}(?:-[a-z0-9]{2,5})?)\b"""),
            Regex("""(?i)\buse\s+([a-z0-9]{2,5}-[a-z0-9]{2,5})\s+to\s+(?:verify|confirm|sign\s+in|login)\b"""),
            Regex("""(?i)\b([a-z0-9]{2,5}-[a-z0-9]{2,5})\b\s+(?:is\s+your|for\s+your)\s+(?:verification\s+)?(?:code|otp|pin|token|passcode)\b"""),
        )

        for (pattern in directPatterns) {
            val match = pattern.find(body) ?: continue
            val otp = match.groupValues.getOrNull(1)?.trim().orEmpty()
            if (otp.isNotEmpty() && otp.any(Char::isDigit)) return otp
        }

        return null
    }

    private fun buildCandidates(body: String): List<OtpCandidate> {
        val candidates = mutableListOf<OtpCandidate>()

        Regex("""(?<!\d)(\d{3}[-\s.]\d{3}|\d{2}[-\s.]\d{4}|\d{4}[-\s.]\d{2})(?!\d)""")
            .findAll(body)
            .forEach { match ->
                val value = match.value.trim()
                val normalized = value.filter { it.isDigit() }
                if (normalized.length in 4..8) {
                    candidates += OtpCandidate(value, normalized, match.range.first, match.range.last + 1, CandidateKind.SEPARATED_NUMERIC)
                }
            }

        Regex("""(?<!\d)[(（\[]\s*(\d{4,8})\s*[)）\]](?!\d)""")
            .findAll(body)
            .forEach { match ->
                val value = match.groupValues[1]
                val start = body.indexOf(value, match.range.first)
                candidates += OtpCandidate(value, value, start, start + value.length, CandidateKind.NUMERIC)
            }

        Regex("""(?<!\d)(\d{4,8})(?!\d)""")
            .findAll(body)
            .forEach { match ->
                val value = match.value
                candidates += OtpCandidate(value, value, match.range.first, match.range.last + 1, CandidateKind.NUMERIC)
            }

        Regex("""(?i)(?<![a-z0-9])(?=[a-z0-9-]{4,10}(?![a-z0-9]))(?=[a-z0-9-]*\d)(?=[a-z0-9-]*[a-z])[a-z0-9]{2,5}(?:-[a-z0-9]{2,5})?(?![a-z0-9])""")
            .findAll(body)
            .forEach { match ->
                val value = match.value
                candidates += OtpCandidate(value, value, match.range.first, match.range.last + 1, CandidateKind.ALPHANUMERIC)
            }

        return candidates
    }

    private fun scoreCandidate(body: String, candidate: OtpCandidate): Int {
        val lower = body.lowercase()
        val before = lower.substring(maxOf(0, candidate.start - 40), candidate.start)
        val after = lower.substring(candidate.end, minOf(lower.length, candidate.end + 40))
        val around = "$before ${after}"
        var score = 0

        if (candidate.kind == CandidateKind.SEPARATED_NUMERIC) score += 18
        if (candidate.kind == CandidateKind.ALPHANUMERIC) score += 8

        score += when (candidate.normalized.length) {
            6 -> 18
            4, 5, 7, 8 -> 10
            else -> 0
        }

        if (Regex("""(?i)(验证码|验码|校验码|认证码|确认码|安全码|登录码|登陆码|短信码|动态码|动态口令|激活码|code|otp|pin|token|security|verification|verify|verifying|authentication)(?:[:：是为\s-]|\bis\b|\bare\b|\bthe\b)*$""").containsMatchIn(before.takeLast(34))) {
            score += 60
        }
        if (Regex("""(?i)^\s*(?:is\s+your|is\s+the|是您|为您|用于|to\s+verify|for\s+verification|verification|code|otp|pin)""").containsMatchIn(after.take(34))) {
            score += 48
        }
        if (candidate.start > 0 && candidate.end < body.length) {
            val open = body[candidate.start - 1]
            val close = body[candidate.end]
            if ((open == '(' && close == ')') || (open == '（' && close == '）') || (open == '[' && close == ']')) {
                score += 44
            }
        }
        if (Regex("""(?i)(weixin|wechat|linking|mobile\s+number|手机号|手机号码|绑定|验证|verify|verifying|verification|one[-\s]?time|security\s+code)""").containsMatchIn(lower)) {
            score += 24
        }

        if (Regex("""(?i)(\$|￥|¥|amount|balance|账单|余额|消费|订单|快递|取件|tracking|parcel)""").containsMatchIn(around)) {
            score -= 70
        }
        if (Regex("""(?i)(http|https|www\.|\.com|\.net|@)""").containsMatchIn(around)) {
            score -= 20
        }
        if (Regex("""(?i)(电话|tel|phone|call|热线|客服)""").containsMatchIn(around) &&
            !Regex("""(?i)(weixin|wechat|verify|verifying|verification|绑定|验证)""").containsMatchIn(lower)
        ) {
            score -= 60
        }
        if (looksLikeDateOrTime(body, candidate)) score -= 70
        if (candidate.normalized.toSet().size == 1) score -= 25
        if (Regex("""0123|1234|2345|3456|4567|5678|6789|9876|8765|7654|6543|5432|4321|3210""").containsMatchIn(candidate.normalized)) {
            score -= 12
        }

        return score
    }

    private fun looksLikeDateOrTime(body: String, candidate: OtpCandidate): Boolean {
        val start = maxOf(0, candidate.start - 2)
        val end = minOf(body.length, candidate.end + 2)
        val around = body.substring(start, end)
        return Regex(
            """(?x)(?<!\d)(?:(?:19|20)\d{2}[-/.](?:0?[1-9]|1[0-2])(?:[-/.](?:0?[1-9]|[12]\d|3[01]))?|(?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])[-/.](?:19|20)?\d{2}|(?:[01]?\d|2[0-3]):[0-5]\d)(?!\d)""",
        ).containsMatchIn(around)
    }

    private fun extractPlatform(body: String, sender: String): String {
        val trimmed = body.trim()

        Regex("""^([【\[<])(.+?)([】\]>])""").find(trimmed)?.let { return clean(it.groupValues[2]) }
        Regex("""([【\[<])(.+?)([】\]>])\s*$""").find(trimmed)?.let { return clean(it.groupValues[2]) }

        val engRegex = Regex("""(?i)\d{4,8}\s+is\s+your\s+(.+?)\s+(?:verification\s+)?(?:code|otp|pin|token)""")
        engRegex.find(body)?.let {
            val brand = it.groupValues[1].trim()
            if (brand.lowercase() != "verification") return clean(brand)
        }

        val cleanSender = sender.replace("+86", "").replace(" ", "")
        carrierMap[cleanSender]?.let { return it }
        if (cleanSender.startsWith("955") || cleanSender.startsWith("966")) return cleanSender
        if (cleanSender.startsWith("106")) return "商业短信"

        Regex("""[（(](.+?)[）)]验证码""").find(body)?.let { return clean(it.groupValues[1]) }
        val knownBrands = listOf("Google", "ChatGPT", "OpenAI", "Microsoft", "Apple", "FaceBook", "Instagram", "Twitter", "Alipay", "WeChat", "淘宝", "腾讯", "giffgaff")
        for (b in knownBrands) {
            if (body.contains(b, ignoreCase = true)) return b
        }

        return ""
    }

    private fun clean(name: String): String {
        val stopWords = listOf("is your", "your", "is", "verification", "code", "官方", "团队", "客服", "通知", "服务")
        var result = name.trim()
        for (word in stopWords) {
            if (result.equals(word, ignoreCase = true)) return ""
            if (result.lowercase().endsWith(word.lowercase())) {
                result = result.substring(0, result.length - word.length).trim()
            }
        }
        return if (result.lowercase() == "is your") "" else result
    }
}
