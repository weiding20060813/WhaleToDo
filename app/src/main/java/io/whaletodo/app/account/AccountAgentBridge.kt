package io.whaletodo.app.account

import io.whaletodo.app.agent.AgentBridge
import io.whaletodo.app.agent.AssistantReply
import io.whaletodo.app.agent.AssistantRequest
import io.whaletodo.core.AgentAccess
import io.whaletodo.core.AgentModel
import kotlinx.coroutines.flow.StateFlow

/** 账户态只覆盖 access；AI 能力仍由原 bridge 提供，未接真实服务时保持原行为。 */
class AccountAgentBridge(
    private val delegate: AgentBridge,
    private val session: AccountSession,
) : AgentBridge {
    override val access: StateFlow<AgentAccess> = session.access
    override val models: List<AgentModel> get() = delegate.models

    override suspend fun reply(request: AssistantRequest): AssistantReply = delegate.reply(request)

    override suspend fun query(requestId: String): AssistantReply = delegate.query(requestId)

    override suspend fun authorizeTemplateTrial(template: String): Boolean =
        delegate.authorizeTemplateTrial(template)
}
