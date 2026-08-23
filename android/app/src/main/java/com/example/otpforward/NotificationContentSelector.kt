package com.example.otpforward

/** Selects only the current item from notifications that also contain conversation history. */
internal object NotificationContentSelector {
    data class Message(
        val sender: String?,
        val text: String?,
        val time: Long,
    )

    fun select(
        title: String?,
        bigTitle: String?,
        text: String?,
        bigText: String?,
        textLines: List<String>,
        messages: List<Message>,
    ): String {
        val heading = firstNotBlank(title, bigTitle)
        val currentBody = selectCurrentBody(text, bigText, textLines, messages)
        return linkedSetOfNotNull(heading.clean(), currentBody.clean()).joinToString(" ")
    }

    private fun selectCurrentBody(
        text: String?,
        bigText: String?,
        textLines: List<String>,
        messages: List<Message>,
    ): String? {
        latestReliableMessage(messages)?.let { message ->
            return listOfNotNull(message.sender.clean(), message.text.clean()).joinToString(" ")
        }
        return when {
            !bigText.isNullOrBlank() -> bigText.trim()
            textLines.any { it.isNotBlank() } -> textLines.last { it.isNotBlank() }.trim()
            else -> text.clean()
        }
    }

    // Some vendors populate EXTRA_MESSAGES without per-message timestamps. In that case the array
    // order is unreliable (newest-first on some devices, oldest-first on others), so fall back to
    // the notification's current summary fields instead of guessing.
    private fun latestReliableMessage(messages: List<Message>): Message? {
        val withText = messages.withIndex().filter { it.value.text.isNotBlankValue() }
        if (withText.isEmpty()) return null
        if (withText.none { it.value.time > 0L }) return null
        return withText
            .maxWithOrNull(compareBy<IndexedValue<Message>> { it.value.time }.thenBy { it.index })
            ?.value
    }

    private fun firstNotBlank(vararg values: String?): String? = values.firstOrNull { !it.isNullOrBlank() }
    private fun String?.clean(): String? = this?.trim()?.takeIf(String::isNotEmpty)
    private fun String?.isNotBlankValue(): Boolean = !this.isNullOrBlank()

    private fun <T : Any> linkedSetOfNotNull(vararg values: T?): LinkedHashSet<T> =
        values.filterNotNullTo(linkedSetOf())
}
