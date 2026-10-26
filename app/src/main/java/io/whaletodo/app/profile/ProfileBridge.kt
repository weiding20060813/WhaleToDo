package io.whaletodo.app.profile

import java.time.LocalDate
import kotlinx.coroutines.flow.*

/** Weiding supplies authenticated account/network/media operations. No permissions, email or payments are faked here. */
data class ProfileDetails(val userId:String,val displayName:String,val publicId:String,val email:String,
    val avatarUri:String?=null,val signInDates:Set<LocalDate> = emptySet(),val businessDate:LocalDate=LocalDate.now(),
    val motto:String="",val vipExpiresAt:java.time.Instant?=null)
enum class AvatarSource { GALLERY,CAMERA }
enum class CodePurpose { REGISTER,RESET_PASSWORD }
data class VerificationDispatch(val resendAfterSeconds:Int=60)
class ProfileUnavailable:Exception()
/** User-facing account failure; message is safe to show and never contains credentials. */
class ProfileException(message:String):Exception(message)
interface ProfileBridge {
    val details:StateFlow<ProfileDetails?>
    suspend fun login(email:String,password:String):Unit=throw ProfileUnavailable()
    /** Null nickname asks the server to derive Whale + the allocated public ID. Never a login credential. */
    suspend fun register(email:String,code:String,password:String,nickname:String?=null):Unit=throw ProfileUnavailable()
    suspend fun requestCode(email:String,purpose:CodePurpose):VerificationDispatch=throw ProfileUnavailable()
    suspend fun resetPassword(email:String,code:String,password:String):Unit=throw ProfileUnavailable()
    suspend fun signOut():Unit=throw ProfileUnavailable()
    suspend fun signIn():Unit=throw ProfileUnavailable()
    suspend fun pickAvatar(source:AvatarSource):String?=throw ProfileUnavailable()
}
object ProfileBridgeHub {
    var bridge:ProfileBridge = object:ProfileBridge { override val details=MutableStateFlow<ProfileDetails?>(null) }
}
