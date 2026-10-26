package io.whaletodo.app.profile

import android.os.SystemClock
import io.whaletodo.app.agent.*
import io.whaletodo.app.data.*
import io.whaletodo.core.*
import java.time.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

enum class MyPageRoute(val title:String) { HOME("我的"),SETTINGS("设置"),ACCOUNT("账户信息"),APPEARANCE("外观设定"),WORKING("Working时间"),REGION("时间和地区"),ABOUT("关于") }
enum class MyDialog { NONE,WORKING_CLOCK,AVATAR,CHECKIN,POINTS,RECHARGE_POINTS,RECHARGE_VIP,LOGIN,REGISTER,RESET_PASSWORD,REMINDERS,DIARY,DIARY_DATE,DELETE_DIARY,OVERWRITE_DIARY,UTC_ZONES,ZONE_CONFIRM }
data class ZoneDraft(val choice:DeskZoneChoice,val previous:DeskZoneChoice,val from:String,val to:String)

data class DiaryOffer(val owner:String,val date:String,val text:String,val messageId:String)
data class DiaryEditor(val date:String,val text:String,val original:DiaryRow?,val editing:Boolean=false,val generated:Boolean=false,val sourceMessageId:String?=null)
data class ProfileState(val owner:String="guest",val access:AgentAccess=AgentAccess(),val details:ProfileDetails?=null,
    val page:MyPageRoute=MyPageRoute.HOME,val dialog:MyDialog=MyDialog.NONE,val options:List<UiPreferenceRow> = emptyList(),val deviceOptions:List<UiPreferenceRow> = emptyList(),
    val busy:Boolean=false,val notice:String="",val error:String="",val diary:DiaryEditor?=null,val pendingDiary:DiaryOffer?=null,
    val workingDay:Int?=null,val codeEmail:String="",val codePurpose:CodePurpose?=null,val codeUntil:Long=0L,val zoneDraft:ZoneDraft?=null) {
    val nickname:String get()=options.find{it.key=="profile.nickname"}?.value?.takeIf{it.isNotBlank()}?:details?.displayName?.takeIf{it.isNotBlank()}?:ProfileIdentity.defaultNickname(details?.publicId?:owner)
    val motto:String get()=options.find{it.key=="profile.motto"}?.value?:details?.motto.orEmpty()
}

@OptIn(ExperimentalCoroutinesApi::class)
class ProfileController(private val repo:DeskRepository,private val scope:CoroutineScope,
    private val bridge:ProfileBridge=ProfileBridgeHub.bridge,private val agent:AgentBridge=AgentBridgeHub.bridge) {
    private val mutable=MutableStateFlow(ProfileState())
    val state:StateFlow<ProfileState> = mutable.asStateFlow()
    init {
        scope.launch {combine(agent.access,bridge.details){a,d->a to d}.collect{(a,d)->
            val owner=a.userId?:"guest"
            mutable.update{if(it.owner!=owner)ProfileState(owner=owner,access=a,details=d?.takeIf{x->x.userId==owner})
                else it.copy(access=a,details=d?.takeIf{x->x.userId==owner})}
        }}
        scope.launch {agent.access.map{it.userId?:"guest"}.distinctUntilChanged().flatMapLatest{owner->
            combine(repo.dao.observeOptions(owner),repo.dao.observeOptions("device")){own,device->Triple(owner,own,device)}
        }.collect{(owner,own,device)->mutable.update{if(it.owner==owner)it.copy(options=own,deviceOptions=device)else it}}}
    }
    fun open(dialog:MyDialog){if(!mutable.value.busy)mutable.update{it.copy(dialog=dialog,error="")}}
    fun navigate(page:MyPageRoute){mutable.update{it.copy(page=page,dialog=MyDialog.NONE,error="",zoneDraft=null)}}
    fun leavePage(){mutable.update{it.copy(page=MyPageRoute.HOME,dialog=MyDialog.NONE,error="",zoneDraft=null,diary=null)}}
    fun saveIdentity(nickname:Boolean,text:String):Boolean {
        val s=mutable.value;if(s.busy)return false
        if(s.access.userId==null){open(MyDialog.LOGIN);return false}
        val clean=runCatching{if(nickname)ProfileIdentity.nickname(text)else ProfileIdentity.motto(text)}.getOrElse{mutable.update{it.copy(error="请检查输入")};return false}
        action { owner->check(owner==mutable.value.owner);repo.dao.save(UiPreferenceRow(owner,if(nickname)"profile.nickname" else "profile.motto",clean));mutable.update{if(it.owner==owner)it.copy(notice="已保存",error="")else it}}
        return true
    }
    fun dismiss(){if(!mutable.value.busy)mutable.update{it.copy(dialog=MyDialog.NONE,error="",diary=null,zoneDraft=null)}}
    fun back(){if(mutable.value.dialog!=MyDialog.NONE)dismiss() else navigate(if(mutable.value.page==MyPageRoute.SETTINGS)MyPageRoute.HOME else MyPageRoute.SETTINGS)}
    fun clearNotice(){mutable.update{it.copy(notice="")}}
    fun option(key:String,default:String="")=mutable.value.options.find{it.key==key}?.value?:default
    private fun action(error:String="暂时无法完成，请稍后重试",block:suspend (String)->Unit) {
        val owner=mutable.value.owner;if(mutable.value.busy)return
        mutable.update{it.copy(busy=true,error="")}
        scope.launch{try{block(owner)}catch(e:CancellationException){throw e}catch(e:ProfileException){mutable.update{if(it.owner==owner)it.copy(error=e.message?:"暂时无法完成，请稍后重试")else it}}
            catch(_:Exception){mutable.update{if(it.owner==owner)it.copy(error=error)else it}}
            finally{mutable.update{if(it.owner==owner)it.copy(busy=false)else it}}}
    }
    fun saveUserOption(key:String,value:String)=action {owner->repo.dao.save(UiPreferenceRow(owner,key,value));dismissAfter(owner)}
    private fun dismissAfter(owner:String,notice:String="已保存"){mutable.update{if(it.owner==owner)it.copy(dialog=MyDialog.NONE,notice=notice,error="")else it}}
    fun avatar(source:AvatarSource)=action("暂时无法打开照片，请稍后重试") {owner->
        val uri=bridge.pickAvatar(source)?:return@action
        require(uri.startsWith("content://"))
        if(mutable.value.owner==owner){repo.dao.saveOptions(listOf(UiPreferenceRow(owner,"avatar.uri",uri),UiPreferenceRow(owner,"avatar.style","custom")));dismissAfter(owner)}
    }
    fun signIn(){if(mutable.value.access.userId==null){open(MyDialog.LOGIN);return}
        action("签到暂不可用，请稍后重试"){owner->bridge.signIn();if(mutable.value.owner==owner)mutable.update{it.copy(notice="签到结果已更新")}}
    }
    private fun validEmail(email:String)=email.length<=254&&Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$").matches(email.trim())
    fun requestCode(email:String,purpose:CodePurpose){
        if(!validEmail(email)){mutable.update{it.copy(error="请输入有效邮箱")};return}
        val s=mutable.value;if(s.codeEmail==email.trim()&&s.codePurpose==purpose&&s.codeUntil>SystemClock.elapsedRealtime())return
        action("暂时无法发送验证码，请稍后重试"){owner->val result=bridge.requestCode(email.trim(),purpose)
            mutable.update{if(it.owner==owner)it.copy(codeEmail=email.trim(),codePurpose=purpose,codeUntil=SystemClock.elapsedRealtime()+result.resendAfterSeconds.coerceIn(1,300)*1000L,notice="验证码已发送")else it}}
    }
    fun authenticate(email:String,password:String,code:String="",register:Boolean=false,reset:Boolean=false,nickname:String?=null){
        val publicName=if(register&&nickname!=null)runCatching{ProfileIdentity.nickname(nickname)}.getOrElse{mutable.update{it.copy(error="请检查昵称")};return}else null
        if(!validEmail(email)||password.length !in 8..200||(register||reset)&&!Regex("[0-9]{4,8}").matches(code)){
            mutable.update{it.copy(error="请检查邮箱、密码（8–200位）和验证码")};return}
        action("账户操作暂不可用，请稍后重试") {owner->
            when{reset->bridge.resetPassword(email.trim(),code,password);register->bridge.register(email.trim(),code,password,publicName);else->bridge.login(email.trim(),password)}
            if(reset||register)mutable.update{if(it.owner==owner)it.copy(dialog=MyDialog.LOGIN,notice=if(reset)"密码已更新" else "注册已完成，请登录")else it}
            else mutable.update{if(it.owner==owner)it.copy(dialog=MyDialog.NONE)else it}
        }
    }
    fun signOut()=action{_->bridge.signOut()}
    fun openWorking(day:Int?){mutable.update{it.copy(workingDay=day,dialog=MyDialog.WORKING_CLOCK,error="")}}
    fun rechargeUnavailable(){mutable.update{it.copy(error="充值尚未开放")}}
    fun saveWorking(start:Int,end:Int,weekday:Int?){
        require(weekday==null||weekday in 1..7);MinuteRange(start,end)
        action{owner->repo.dao.save(UiPreferenceRow("device","working.${weekday?:"default"}","$start,$end"));dismissAfter(owner)}
    }
    fun clearWeekday(day:Int)=action{_->repo.dao.removeOption("device","working.$day")}
    fun proposeZone(value:String,daylight:Boolean?=null) {
        val id=if(value=="system")value else runCatching{DeskZones.parse(value)}.getOrElse{mutable.update{it.copy(error="请选择有效时区")};return}
        val previous=DeskOptions.zoneChoice(mutable.value.deviceOptions)
        val choice=DeskZoneChoice(id,daylight?:if(id==previous.id)previous.daylight else true)
        mutable.update{it.copy(dialog=MyDialog.ZONE_CONFIRM,error="",zoneDraft=ZoneDraft(choice,previous,previous.effective().id,choice.effective().id))}
    }
    fun confirmZone(adjust:Boolean) {
        val draft=mutable.value.zoneDraft?:return
        action("暂时无法更改时区，请重新选择") { owner->
            try{repo.changeZone(draft.choice,adjust,draft.previous,draft.from)}catch(e:IllegalArgumentException){mutable.update{if(it.owner==owner)it.copy(error=e.message?:"请检查日程时间")else it};return@action}
            dismissAfter(owner,"时区已更新")
            mutable.update{if(it.owner==owner)it.copy(zoneDraft=null)else it}
        }
    }
    fun saveReminderDefaults(enabled:Boolean,method:String,stars:Int){require(stars in 0..5);require(ReminderMethod.entries.any{it.code==method})
        action{owner->repo.dao.saveOptions(listOf("reminder.enabled" to enabled.toString(),"reminder.method" to method,"reminder.stars" to stars.toString()).map{(key,value)->UiPreferenceRow(owner,key,value)});dismissAfter(owner,"提醒偏好已保存")}}
    fun offerDiary(owner:String,date:String,text:String,messageId:String){
        val clean=DiaryContent.fromAssistant(text)?:return
        mutable.update{if(it.owner==owner)it.copy(pendingDiary=DiaryOffer(owner,date,clean,messageId))else it}
    }
    fun showPendingDiary(){val s=mutable.value;val offer=s.pendingDiary?:return
        if(s.dialog!=MyDialog.NONE||s.busy)return
        mutable.update{it.copy(pendingDiary=null)};loadDiary(offer.date,offer)
    }
    fun openDiary(date:LocalDate)=loadDiary(date.toString())
    private fun loadDiary(date:String,offer:DiaryOffer?=null)=action("暂时无法打开日记") {owner->
        val row=repo.dao.diary(owner,date)
        mutable.update{if(it.owner==owner)it.copy(dialog=MyDialog.DIARY,error="",diary=DiaryEditor(date,offer?.text?:row?.content.orEmpty(),row,offer!=null,offer!=null,offer?.messageId))else it}}
    fun editDiary(){mutable.update{it.copy(diary=it.diary?.copy(editing=true))}}
    fun diaryText(text:String){if(text.length<=4000)mutable.update{it.copy(diary=it.diary?.copy(text=text),error="")}}
    fun saveDiary(confirmed:Boolean=false){val s=mutable.value;val editor=s.diary?:return
        val text=runCatching{DiaryContent.validate(editor.text)}.getOrElse{mutable.update{it.copy(error="日记需为1–800字")};return}
        if(editor.generated&&editor.original!=null&&!confirmed){open(MyDialog.OVERWRITE_DIARY);return}
        action("日记已变化，请重新打开后保存"){owner->
            repo.saveDiary(owner,editor.date,text,editor.original,editor.sourceMessageId);dismissAfter(owner,"日记已保存")}
    }
    fun confirmDeleteDiary(){val editor=mutable.value.diary?:return;val row=editor.original?:return
        action("日记已变化，请重新打开"){owner->repo.deleteDiary(row);dismissAfter(owner,"日记已删除")}}
}
