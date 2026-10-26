package io.whaletodo.app.account

import io.whaletodo.app.profile.ProfileDetails
import io.whaletodo.core.AgentAccess
import io.whaletodo.network.AccountProfile
import io.whaletodo.network.Entitlements
import java.time.LocalDate
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** 登录态的唯一真源：AgentAccess 与 ProfileBridge.details 都由这里同步更新。 */
class AccountSession {
    private val mutableAccess = MutableStateFlow(AgentAccess())
    val access: StateFlow<AgentAccess> = mutableAccess.asStateFlow()

    private val mutableDetails = MutableStateFlow<ProfileDetails?>(null)
    val details: StateFlow<ProfileDetails?> = mutableDetails.asStateFlow()

    private val mutableEmail = MutableStateFlow<String?>(null)
    val email: StateFlow<String?> = mutableEmail.asStateFlow()

    fun update(
        email: String,
        profile: AccountProfile,
        entitlements: Entitlements,
        availablePoints: Int,
    ) {
        val previous = mutableDetails.value?.takeIf { it.userId == profile.id }
        mutableEmail.value = email
        mutableDetails.value = ProfileDetails(
            userId = profile.id,
            displayName = profile.displayName.orEmpty(),
            publicId = profile.username,
            email = email,
            signInDates = previous?.signInDates.orEmpty(),
            businessDate = previous?.businessDate ?: LocalDate.now(),
            vipExpiresAt = entitlements.vipExpiresAt,
        )
        mutableAccess.value = AgentAccess(
            userId = profile.id,
            vip = entitlements.vipActive,
            availablePoints = availablePoints,
            connected = true,
        )
    }

    fun updateBalance(entitlements: Entitlements, availablePoints: Int) {
        mutableAccess.update {
            it.copy(vip = entitlements.vipActive, availablePoints = availablePoints)
        }
        mutableDetails.update { current ->
            current?.copy(vipExpiresAt = entitlements.vipExpiresAt)
        }
    }

    fun markSignedIn(date: LocalDate) {
        mutableDetails.update { current ->
            current?.copy(
                signInDates = current.signInDates + date,
                businessDate = date,
            )
        }
    }

    fun clear() {
        mutableEmail.value = null
        mutableDetails.value = null
        mutableAccess.value = AgentAccess()
    }
}
