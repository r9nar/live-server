// @ts-nocheck
/**
 * معالج أحداث الودجتات — نفس منطق الديسكتوب بالحرف.
 * مصدر واحد للأحداث: ConnectionManager (slim) → الرسائل الجاهزة للغرف.
 */

// ── قيم أحداث TikTok كما تيجي من محرّك الاتصال ─────────────────────────────
const TIKTOK_EVENTS = {
  CHAT: 'chat',
  GIFT: 'gift',
  LIKE: 'like',
  FOLLOW: 'follow',
  JOIN: 'join',
  MEMBER: 'member',
  EMOTE: 'emote',
  SUPERFAN: 'superfan',
  SHARE: 'share',
  ROOM_USER: 'roomUser',
  ROOM_INFO: 'roominfo',
  CONNECTED: 'connected',
  CONNECTING: 'connecting',
  STREAM_END: 'stream-end',
  DISCONNECTED: 'disconnected'
}

// ── أسماء الأحداث اللي الفرونت بيستقبلها ──────────────────────────────────
const FRONT_EVENTS = {
  GIFT: 'gift',
  LIKE_OVERLAY: 'like_overlay_update',
  LIKE_GOAL: 'like_goal_update',
  HEART_ME_GOAL: 'heartMeGoalUpdate',
  TOP_LIKES: 'top_likes_update',
  FOLLOW_OVERLAY: 'follow_overlay_update',
  FOLLOW_GOAL: 'follow_goal_update',
  CHAT_COMMENT: 'chat_widget_comment',
  TTS_COMMENT: 'tts_comment',
  GIFT_CHALLENGE: 'gift_challenge_gift',
  FIREWORK_GIFT: 'firework_gift',
  LATEST_EVENT: 'latest_event',
  HIGHEST_GIFT: 'highest_gift_update',
  TOP_SUPPORTERS: 'top_supporters_update',
  TOP_GIFTERS: 'top_gifters_update',
  GIFT_GOAL: 'gift_goal_update',
  TOP_RANKERS: 'top_rankers_update',
  ROOM_VIEWERS: 'room_viewers_update',
  ROOM_INFO: 'room_info_update',
  OBS_DOCKS_COMMENT: 'obs_docks_comment',
  OBS_DOCKS_FOLLOW: 'obs_docks_follow',
  OBS_DOCKS_GIFT: 'obs_docks_gift',
  OBS_DOCKS_SHARE: 'obs_docks_share',
  ACTION_ALERT: 'action_alert',
  KEYBOARD_EXECUTE: 'desktop_keyboard_execute',
  ACTION_CHANGED: 'action-changed',
  ACTION_CHANGED_ALT: 'action:changed',
  ACTION_CHANGED_OVERLAY: 'overlay:action:changed',
  ACTIONS_SLIDER_SETTINGS: 'actions_slider_settings_updated',
  ACTIONS_SLIDER_UPDATE: 'actions-slider-settings-update'
}

// ── أحداث الإعدادات: الـ API بيبلّغ السوكت → الفرونت ─────────────────────
const SETTINGS_EVENTS = {
  gift_goal: 'gift_goal_settings',
  follow_goal: 'follow_goal_settings',
  like_goal: 'like_goal_settings',
  heart_me_goal: 'updateGoalSettings',
  gift_goal_reset: 'gift_goal_reset',
  follow_goal_reset: 'follow_goal_reset',
  like_goal_reset: 'like_goal_reset',
  heart_me_goal_reset: 'heartMeGoalReset',
  like_overlay: 'like-settings-update',
  follow_overlay: 'follow-settings-update',
  heart_fountain: 'heart_fountain_settings_changed',
  firework: 'firework_settings_changed',
  firework_v2: 'firework_v2_settings_changed',
  top_likes_theme: 'theme_changed',
  top_gifters_theme: 'top_gifters_theme_changed',
  top_likes_reset: 'top_likes_reset',
  top_gifters_reset: 'top_gifters_reset',
  social_rotator: 'social_rotator_settings_updated',
  highest_gift_reset: 'highest_gift_reset',
  the_last_gift: 'the_last_gift_settings_update',
  latest_events: 'latest_events_settings_changed',
  actions_overlay: 'overlay_config_updated'
}

// الودجتات دي بتستقبل { settings } — الباقي بيستقبل الإعدادات مباشرة
const WRAPPED_SETTINGS = new Set(['like_overlay', 'follow_overlay', 'social_rotator', 'the_last_gift', 'latest_events'])

/**
 * بناء رسالة تغيير إعدادات جاهزة للسوكت.
 * @returns {{ to, userId, target, event, payload }|null}
 */
function buildSettingsMessage({ kind, userId, settings = {}, screen = 1 } = {}) {
  const event = SETTINGS_EVENTS[kind]
  if (!event || !userId) return null

  if (kind === 'actions_overlay') {
    const screenNumber = Number(screen) || 1
    return {
      to: 'overlay',
      userId,
      target: String(screenNumber),
      event,
      payload: { type: 'actions', screen: screenNumber, maxQueue: Number(settings.maxQueue) || 10 }
    }
  }

  if (kind === 'top_likes_theme' || kind === 'top_gifters_theme') {
    return {
      to: 'user',
      userId,
      target: null,
      event,
      payload: {
        theme: settings.theme,
        visibleRanks: settings.visibleRanks,
        direction: settings.direction
      }
    }
  }

  return {
    to: 'user',
    userId,
    target: null,
    event,
    payload: WRAPPED_SETTINGS.has(kind) ? { settings } : { ...settings }
  }
}

// أحداث تجريبية (زر Test في الداشبورد) — بتاخد نفس مسار أحداث TikTok
const TEST_EVENT_VALUES = [TIKTOK_EVENTS.LIKE, TIKTOK_EVENTS.FOLLOW]

function buildTestEvent(type) {
  if (!TEST_EVENT_VALUES.includes(type)) return null
  return {
    type,
    eventLabel: type,
    user: {
      userId: 'test-user',
      uniqueId: 'test_user',
      nickname: 'Test User',
      avatar: '/assets/img/avatar1.png'
    },
    data: type === TIKTOK_EVENTS.LIKE ? { likeCount: 10, totalLikeCount: 10 } : {}
  }
}

// القيم اللي محرك الإجراءات بيتفعّل عليها
const ACTION_EVENT_VALUES = [
  TIKTOK_EVENTS.GIFT,
  TIKTOK_EVENTS.LIKE,
  TIKTOK_EVENTS.FOLLOW,
  TIKTOK_EVENTS.CHAT,
  TIKTOK_EVENTS.EMOTE,
  TIKTOK_EVENTS.SUPERFAN,
  TIKTOK_EVENTS.JOIN,
  TIKTOK_EVENTS.MEMBER
]

const DEFAULT_FONT = "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif"
const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

function actionTypesOf(action) {
  if (Array.isArray(action.action_types) && action.action_types.length > 0) return action.action_types
  return action.action_type ? [action.action_type] : ['message']
}

// ── بناء بيانات الأحداث ───────────────────────────────────────────────────

function buildActionAlertPayload(action, { label, data = {}, user = {} } = {}) {
  return {
    actionId: action.id,
    type: label,
    uniqueId: user.uniqueId || '',
    nickname: user.nickname || '',
    avatar: user.avatar || '',
    message: action.message_text || '',
    duration: Number(action.duration_seconds) || 5,
    info_delay_seconds: Number(action.info_delay_seconds) || 0,
    volume_level: action.volume_level ?? 80,
    action_types: actionTypesOf(action),
    video_url: action.video_url || null,
    audio_url: action.audio_url || null,
    audio_filename: action.audio_filename || null,
    giftName: data.giftName || action.gift_name || '',
    giftCoins: Number(data.diamondCount || action.gift_coins || 0),
    gift_image_url: data.giftPictureUrl || action.gift_image || '',
    avatar_size: action.avatar_size ?? 150,
    border_color: action.border_color || '#ff0000',
    name_color: action.name_color || '#ffffff',
    message_color: action.message_color || '#ffee00',
    name_font_size: action.name_font_size ?? 28,
    message_font_size: action.message_font_size ?? 22,
    name_font_family: action.name_font_family || DEFAULT_FONT,
    message_font_family: action.message_font_family || DEFAULT_FONT
  }
}

function buildKeyboardPayload(action) {
  return {
    keyboard_keys: action.keyboard_keys,
    keyboard_hold_ms: Number(action.keyboard_hold_ms) || 0,
    keyboard_queue_delay_ms:
      action.keyboard_queue_delay_ms != null ? Number(action.keyboard_queue_delay_ms) : null,
    keyboard_queue_max:
      action.keyboard_queue_max != null ? Number(action.keyboard_queue_max) : null
  }
}

function buildTtsCommentPayload(data = {}, user = {}) {
  return {
    msgId: data.msgId || newId(),
    comment: data.comment || '',
    userId: user.userId || '',
    uniqueId: user.uniqueId || '',
    nickname: user.nickname || '',
    avatar: user.avatar || '',
    isModerator: data.isModerator === true,
    isSubscriber: data.isSubscriber === true,
    isFollower: data.isFollower === true,
    teamLevel: Number(data.teamLevel || 0)
  }
}

/**
 * معالج الأحداث: بيحوّل قيمة حدث TikTok → رسائل جاهزة للسوكت.
 * كل رسالة: { to, userId, target, event, payload }
 *   to: 'user' | 'dashboards' | 'widget' | 'overlay'
 *   target: نوع الودجت (widget) أو رقم الشاشة (overlay)
 */
function createEventProcessor() {
  const stats = {
    likesByUser: new Map(), // userId -> { nickname, uniqueId, avatar, score }
    supportersByUser: new Map(), // userId -> { nickname, avatar, supporter_username, total_diamonds }
    giftStreaks: new Map(), // groupId -> { lastRepeat, at }
    highestGift: null,
    lastGift: null,
    topRankers: [], // آخر أفضل 3 في اللايف
    totalLikes: 0,
    follows: 0,
    giftDiamonds: 0,
    heartMeCount: 0
  }

  const actionsByUser = new Map() // userId -> Action[]
  const triggeredOnce = new Set() // إجراءات مرة واحدة في الجلسة

  function reset() {
    stats.likesByUser.clear()
    stats.supportersByUser.clear()
    stats.giftStreaks.clear()
    stats.highestGift = null
    stats.lastGift = null
    stats.topRankers = []
    stats.totalLikes = 0
    stats.follows = 0
    stats.giftDiamonds = 0
    stats.heartMeCount = 0
    triggeredOnce.clear()
  }

  /**
   * تيك توك بيبعت الكومبو على دفعات وكل دفعة فيها العدد التراكمي (2، 4، 7...).
   * نرجّع الفرق بس عشان مانحسبش نفس الهدية أكثر من مرة.
   */
  function giftDelta(groupId, repeatCount, repeatEnd) {
    if (!groupId) return repeatCount
    const now = Date.now()
    for (const [id, streak] of stats.giftStreaks) {
      if (now - streak.at > 60000) stats.giftStreaks.delete(id)
    }
    const prev = stats.giftStreaks.get(groupId)
    const delta = Math.max(repeatCount - (prev?.lastRepeat || 0), 0)
    if (repeatEnd) stats.giftStreaks.delete(groupId)
    else stats.giftStreaks.set(groupId, { lastRepeat: repeatCount, at: now })
    return delta
  }

  // ── الإجراءات ───────────────────────────────────────────────────────────
  function setActions(userId, actions) {
    if (!userId) return 0
    const list = Array.isArray(actions) ? actions : []
    actionsByUser.set(String(userId), list)
    return list.length
  }

  /** الإجراءات المتزامنة لمستخدم معيّن (تستخدمها ودجتات مثل Actions Slider) */
  function getActions(userId) {
    if (!userId) return []
    return actionsByUser.get(String(userId)) || []
  }

  /** أعلى هدية في الجلسة الحالية (يستخدمها ودجت highest-gift عند التحميل) */
  function getHighestGift() {
    return stats.highestGift
  }

  function resetHighestGift() {
    stats.highestGift = null
  }

  /** آخر هدية وصلت (يستخدمها ودجت The Last Gift عند التحميل) */
  function getLastGift() {
    return stats.lastGift
  }

  /** أعلى 10 متفاعلين باللايكات (ودجت top-likes عند التحميل) */
  function getTopLikes(limit = 10) {
    return [...stats.likesByUser.values()].sort((a, b) => b.score - a.score).slice(0, limit)
  }

  /** آخر أفضل 3 في اللايف (ودجت top-rankers عند التحميل) */
  function getTopRankers() {
    return stats.topRankers
  }

  /** تصفير عدّاد هدية Heart Me (زر إعادة تعيين هدف "هدية أحبني") */
  function resetHeartMe() {
    stats.heartMeCount = 0
  }

  /** ترتيب الداعمين (يستخدمه ودجتات top-supporters / top-gifters عند التحميل) */
  function getSupporters(limit = 20) {
    return [...stats.supportersByUser.values()]
      .sort((a, b) => b.total_diamonds - a.total_diamonds)
      .slice(0, limit)
      .map((item, index) => ({ rank: index + 1, ...item }))
  }

  function upsertAction(userId, changeType, action) {
    if (!userId || !action || !action.id) return
    const uid = String(userId)
    const list = actionsByUser.get(uid) || []
    const index = list.findIndex((item) => String(item.id) === String(action.id))
    if (changeType === 'delete') {
      if (index >= 0) list.splice(index, 1)
    } else if (index >= 0) {
      list[index] = action
    } else {
      list.push(action)
    }
    actionsByUser.set(uid, list)
  }

  function matchActions(userId, label, data = {}, user = {}) {
    const list = actionsByUser.get(String(userId || ''))
    if (!list || list.length === 0) return []
    const matched = []

    for (const action of list) {
      if (!action || action.is_enabled === false) continue
      const type = String(action.type || '')
      let hit = false

      if (type === 'specific_gift') {
        hit = label === TIKTOK_EVENTS.GIFT && String(action.gift_id || '') === String(data.giftId || '')
      } else if (type === 'min_coins') {
        const min = Number(action.min_coins || 0)
        hit = label === TIKTOK_EVENTS.GIFT && min > 0 && Number(data.diamondCount || 0) >= min
      } else if (type === 'min_likes') {
        const target = Number(action.min_likes || 0)
        const key = `like:${action.id}:${target}`
        if (label === TIKTOK_EVENTS.LIKE && target > 0 && stats.totalLikes >= target && !triggeredOnce.has(key)) {
          triggeredOnce.add(key)
          hit = true
        }
      } else if (type === 'follow') {
        hit = label === TIKTOK_EVENTS.FOLLOW
      } else if (type === 'superfan') {
        // أي حدث سوبر فان في البث (مش مرتبط بمستخدم معيّن)
        hit = label === TIKTOK_EVENTS.SUPERFAN
      } else if (type === 'specific_comment') {
        const want = String(action.comment_text || '').trim().toLowerCase()
        // الفلتر الاختياري باسم المستخدم (لو محدد في الإجراء)
        const wantUser = String(action.comment_username || '')
          .replace(/^@/, '')
          .trim()
          .toLowerCase()
        const sameUser = !wantUser || wantUser === String(user.uniqueId || '').toLowerCase()
        hit =
          label === TIKTOK_EVENTS.CHAT &&
          !!want &&
          sameUser &&
          String(data.comment || '').toLowerCase().includes(want)
      } else if (type === 'comment_emote') {
        hit =
          label === TIKTOK_EVENTS.EMOTE &&
          !!action.comment_emote_id &&
          !!data.emoteId &&
          String(data.emoteId) === String(action.comment_emote_id)
      } else if (type === 'specific_join_user') {
        const want = String(action.join_username || '').replace(/^@/, '').toLowerCase()
        hit =
          (label === TIKTOK_EVENTS.JOIN || label === TIKTOK_EVENTS.MEMBER) &&
          !!want &&
          want === String(user.uniqueId || '').toLowerCase()
      }

      if (hit) matched.push(action)
    }
    return matched
  }

  /**
   * تحويل حدث واحد لرسائل جاهزة.
   * @returns {{ state: Object|null, messages: Array }}
   */
  function process(event = {}, userId = '') {
    const label = event.eventLabel || event.type || ''
    const data = event.data || {}
    const user = event.user || {}
    const messages = []
    let state = null

    const send = (to, target, name, payload) =>
      messages.push({ to, userId, target, event: name, payload })

    // قناة event العامة (نفس الشكل اللي obs-docks وغيرها بيستقبله)
    const sendEvent = (name, payload) =>
      send('user', null, 'event', { type: name, data: payload })

    // أحداث صفحة Latest Events (آخر لايك/متابعة/دخول/شير/هدية)
    const sendLatest = (eventType) =>
      send('user', null, FRONT_EVENTS.LATEST_EVENT, {
        eventType,
        userId: user.userId || '',
        uniqueId: user.uniqueId || '',
        nickname: user.nickname || '',
        avatar: user.avatar || ''
      })

    switch (label) {
      case TIKTOK_EVENTS.LIKE: {
        const likeCount = Number(data.likeCount ?? data.count ?? 1) || 1
        const totalLikes = Number(data.totalLikeCount ?? 0)

        send('user', null, FRONT_EVENTS.LIKE_OVERLAY, {
          userId: user.userId || '',
          nickname: user.nickname || '',
          avatar: user.avatar || '',
          likeCount
        })
        sendLatest('like')

        stats.totalLikes = totalLikes > 0 ? totalLikes : stats.totalLikes + likeCount
        send('user', null, FRONT_EVENTS.LIKE_GOAL, { current_value: stats.totalLikes })

        const likeKey = user.userId || user.uniqueId
        if (likeKey) {
          const prev = stats.likesByUser.get(likeKey) || {
            nickname: user.nickname || '',
            uniqueId: user.uniqueId || '',
            avatar: user.avatar || '',
            score: 0
          }
          prev.score += likeCount
          if (user.nickname) prev.nickname = user.nickname
          if (user.avatar) prev.avatar = user.avatar
          stats.likesByUser.set(likeKey, prev)

          const top10 = [...stats.likesByUser.values()].sort((a, b) => b.score - a.score).slice(0, 10)
          send('user', null, FRONT_EVENTS.TOP_LIKES, { top10 })
        }
        break
      }

      case TIKTOK_EVENTS.FOLLOW:
        stats.follows += 1
        send('user', null, FRONT_EVENTS.FOLLOW_OVERLAY, {
          nickname: user.nickname || '',
          avatar: user.avatar || ''
        })
        sendLatest('follow')
        send('user', null, FRONT_EVENTS.FOLLOW_GOAL, { current_value: stats.follows })
        sendEvent(FRONT_EVENTS.OBS_DOCKS_FOLLOW, {
          profilePicture: user.avatar || '',
          user: { userId: user.userId || '', uniqueId: user.uniqueId || '', nickname: user.nickname || '', avatar: user.avatar || '' }
        })
        break

      case TIKTOK_EVENTS.CHAT:
      case TIKTOK_EVENTS.EMOTE: {
        const stickerUrl = data.stickerUrl || ''
        const chatUser = {
          userId: user.userId || '',
          uniqueId: user.uniqueId || '',
          nickname: user.nickname || '',
          avatar: user.avatar || ''
        }
        const identity = {
          isModerator: data.isModerator === true,
          isSubscriber: data.isSubscriber === true
        }
        const badges = {
          moderator: { icon: null },
          support: { level: null, icon: null },
          team: { level: null, name: null, icon: null }
        }

        send('user', null, FRONT_EVENTS.CHAT_COMMENT, {
          meta: { msgId: data.msgId || newId() },
          message: {
            text: data.comment || '',
            hasEmotes: !!stickerUrl,
            emotesCount: stickerUrl ? 1 : 0,
            emotes: stickerUrl ? [{ imageUrl: stickerUrl }] : []
          },
          user: chatUser,
          identity,
          badges
        })

        if (label === TIKTOK_EVENTS.CHAT && data.comment) {
          sendEvent(FRONT_EVENTS.OBS_DOCKS_COMMENT, {
            user: chatUser,
            timestamp: Date.now(),
            text: data.comment || '',
            profilePicture: user.avatar || '',
            emotes: stickerUrl ? [{ imageUrl: stickerUrl, placeInComment: 0 }] : [],
            identity,
            badges
          })
        }

        // القارئ الصوتي: حدث مستقل للداشبورد (جوّه حدث event العام)
        if (label === TIKTOK_EVENTS.CHAT && data.comment) {
          send('dashboards', null, 'event', {
            type: FRONT_EVENTS.TTS_COMMENT,
            data: buildTtsCommentPayload(data, user)
          })
        }
        break
      }

      case TIKTOK_EVENTS.GIFT: {
        const repeatCount = Number(data.repeatCount ?? 1) || 1
        const repeatEnd = Number(data.repeatEnd ?? 0) === 1
        const groupId = data.groupId ? String(data.groupId) : ''
        const delta = giftDelta(groupId, repeatCount, repeatEnd)
        const diamondPer = Number(data.diamondCount ?? 0) || 0
        const giftImageUrl = data.giftPictureUrl || ''

        const sender = {
          userId: user.userId || '',
          uniqueId: user.uniqueId || '',
          nickname: user.nickname || '',
          avatar: user.avatar || ''
        }
        const gift = {
          giftId: String(data.giftId ?? ''),
          giftName: data.giftName || '',
          giftCount: delta,
          deltaCount: delta,
          giftCoins: diamondPer * Math.max(delta, 0),
          sender,
          user: event.user || null
        }
        send('widget', 'gift_challenge', FRONT_EVENTS.GIFT_CHALLENGE, gift)
        send('widget', 'supporters_challenge', FRONT_EVENTS.GIFT_CHALLENGE, gift)

        // هدف "Heart Me" = هدية Heart Me نفسها فقط (giftId 7934) وليس اللايكات
        if (String(gift.giftId) === '7934' || gift.giftName === 'Heart Me') {
          stats.heartMeCount += Math.max(delta, 0)
          send('user', null, FRONT_EVENTS.HEART_ME_GOAL, { current_value: stats.heartMeCount })
        }

        // OBS Docks: تفاصيل الهدية والكومبو
        sendEvent(FRONT_EVENTS.OBS_DOCKS_GIFT, {
          ...sender,
          user: sender,
          profilePictureUrl: user.avatar || '',
          giftName: gift.giftName,
          giftPictureUrl: giftImageUrl,
          repeatCount,
          repeatEnd: repeatEnd ? 1 : 0,
          diamondCount: diamondPer
        })

        if (delta > 0) {
          sendLatest('gift')
          send('user', null, FRONT_EVENTS.FIREWORK_GIFT, {
            giftCount: delta,
            giftName: gift.giftName,
            giftImageUrl,
            giftCoins: diamondPer,
            sender: {
              nickname: user.nickname || '',
              uniqueId: user.uniqueId || '',
              avatar: user.avatar || ''
            }
          })

          // The Last Gift: آخر هدية مع صورة الهدية وقيمتها
          const lastGiftPayload = {
            giftName: gift.giftName,
            giftCount: delta,
            giftCoins: diamondPer,
            giftImageUrl,
            sender: {
              nickname: user.nickname || '',
              uniqueId: user.uniqueId || '',
              avatar: user.avatar || ''
            }
          }
          stats.lastGift = lastGiftPayload
          send('widget', 'the-last-gift', FRONT_EVENTS.GIFT, lastGiftPayload)
        }

        const totalDiamonds = diamondPer * repeatCount
        if (totalDiamonds > 0 && (!stats.highestGift || totalDiamonds > stats.highestGift.diamondCount)) {
          stats.highestGift = {
            giftId: gift.giftId,
            giftName: gift.giftName,
            giftImageUrl,
            diamondCount: totalDiamonds,
            nickname: user.nickname || '',
            uniqueId: user.uniqueId || '',
            profilePictureUrl: user.avatar || ''
          }
          send('user', null, FRONT_EVENTS.HIGHEST_GIFT, stats.highestGift)
        }

        const supporterKey = user.userId || user.uniqueId
        if (supporterKey && delta > 0 && diamondPer > 0) {
          const prev = stats.supportersByUser.get(supporterKey) || {
            userId: user.userId || '',
            nickname: user.nickname || '',
            avatar: user.avatar || '',
            supporter_username: user.uniqueId || '',
            total_diamonds: 0
          }
          prev.total_diamonds += diamondPer * delta
          if (user.nickname) prev.nickname = user.nickname
          if (user.avatar) prev.avatar = user.avatar
          stats.supportersByUser.set(supporterKey, prev)

          const sorted = [...stats.supportersByUser.values()].sort(
            (a, b) => b.total_diamonds - a.total_diamonds
          )
          const top20 = sorted.slice(0, 20).map((item, index) => ({ rank: index + 1, ...item }))
          send('user', null, FRONT_EVENTS.TOP_SUPPORTERS, { top20 })

          // Top Gifters: نفس التجميع لكن أعلى 50 (widget top-gifters)
          // الشكل مسطّح لأن renderer الودجت بيقرأ { nickname, avatar, score }
          const top50 = sorted.slice(0, 50).map((item, index) => ({
            rank: index + 1,
            nickname: item.nickname || '',
            avatar: item.avatar || '',
            uniqueId: item.supporter_username || '',
            score: item.total_diamonds
          }))
          send('user', null, FRONT_EVENTS.TOP_GIFTERS, { top50 })
        }

        stats.giftDiamonds += diamondPer * delta
        send('user', null, FRONT_EVENTS.GIFT_GOAL, { current_value: stats.giftDiamonds })
        break
      }

      case TIKTOK_EVENTS.ROOM_USER: {
        const ranks = Array.isArray(data.ranksList) ? data.ranksList : []
        const top3 = ranks.slice(0, 3).map((entry, index) => ({
          rank: entry?.rank || index + 1,
          userId: entry?.userId || entry?.user?.userId || '',
          uniqueId: entry?.uniqueId || entry?.user?.uniqueId || '',
          nickname: entry?.nickname || entry?.user?.nickname || '',
          avatar: entry?.avatar || entry?.user?.avatar || '',
          coinCount: Number(entry?.coinCount ?? entry?.score ?? 0)
        }))
        // غرفة المستخدم تضم الداشبورد + الودجت (top-rankers مش بتعمل joinWidget)
        stats.topRankers = top3
        send('user', null, FRONT_EVENTS.TOP_RANKERS, { top3 })

        const viewers = {
          currentViewerCount: Number(data.viewerCount || 0),
          totalUser: Number(data.totalUser ?? data.totalUserCount ?? 0),
          popularity: Number(data.popularity || 0)
        }
        send('dashboards', null, FRONT_EVENTS.ROOM_VIEWERS, viewers)
        sendEvent(FRONT_EVENTS.ROOM_VIEWERS, viewers)
        break
      }

      case TIKTOK_EVENTS.JOIN:
        sendLatest('join')
        break

      case TIKTOK_EVENTS.ROOM_INFO:
        // غرفة المستخدم = الداشبورد + ودجت top-rankers (مش بتعمل joinWidget)
        send('user', null, FRONT_EVENTS.ROOM_INFO, data)
        break

      case TIKTOK_EVENTS.SHARE:
        sendLatest('share')
        sendEvent(FRONT_EVENTS.OBS_DOCKS_SHARE, {
          profilePicture: user.avatar || '',
          user: { userId: user.userId || '', uniqueId: user.uniqueId || '', nickname: user.nickname || '', avatar: user.avatar || '' }
        })
        break

      case TIKTOK_EVENTS.CONNECTED:
        state = {
          state: 'connected',
          uniqueId: event.username || '',
          roomId: event.roomId || '',
          message: ''
        }
        break

      case TIKTOK_EVENTS.CONNECTING:
        state = { state: 'connecting', uniqueId: event.username || '', roomId: event.roomId || '' }
        break

      case TIKTOK_EVENTS.STREAM_END:
      case TIKTOK_EVENTS.DISCONNECTED:
        state = { state: 'disconnected', uniqueId: event.username || '', roomId: event.roomId || '' }
        break

      default:
        break
    }

    // الإجراءات بعد تحديث الإحصائيات
    if (userId && ACTION_EVENT_VALUES.includes(label)) {
      for (const action of matchActions(userId, label, data, user)) {
        send('overlay', action.screen || 1, FRONT_EVENTS.ACTION_ALERT,
          buildActionAlertPayload(action, { label, data, user }))

        const types = actionTypesOf(action)
        if (types.includes('keyboard') && Array.isArray(action.keyboard_keys) && action.keyboard_keys.length > 0) {
          send('user', null, FRONT_EVENTS.KEYBOARD_EXECUTE, buildKeyboardPayload(action))
        }
      }
    }

    return { state, messages }
  }

  return { process, reset, setActions, getActions, getHighestGift, getLastGift, getTopLikes, getTopRankers, resetHighestGift, resetHeartMe, getSupporters, upsertAction }
}

export {
  TIKTOK_EVENTS,
  FRONT_EVENTS,
  SETTINGS_EVENTS,
  ACTION_EVENT_VALUES,
  TEST_EVENT_VALUES,
  buildSettingsMessage,
  buildTestEvent,
  actionTypesOf,
  buildActionAlertPayload,
  buildKeyboardPayload,
  buildTtsCommentPayload,
  createEventProcessor
}
