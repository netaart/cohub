package live.cohub.android.auth

class SignInFlow(private val ended: (outcome: String) -> Unit) {
    enum class Stage {
        GOOGLE,

        BROWSER,

        EXCHANGE,
    }

    var stage: Stage? = null
        private set

    var attempt = 0
        private set

    fun begin(stage: Stage): Boolean {
        if (this.stage != null && this.stage != Stage.BROWSER) return false
        this.stage = stage
        attempt++
        return true
    }

    fun advance(stage: Stage) {
        if (this.stage != null) this.stage = stage
    }

    fun end(outcome: String, attempt: Int = this.attempt) {
        if (stage == null || attempt != this.attempt) return
        stage = null
        ended(outcome)
    }
}
