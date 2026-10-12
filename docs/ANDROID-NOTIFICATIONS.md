# Android reminders and live class updates

Class reminders use one replaceable notification slot, so successive classes do not leave a stack. Deadline lead reminders share an occurrence identity. Notifications expire no later than their event's end or deadline, and a calendar refresh removes obsolete reminders. When a live tracker replaces the matching class reminder, a brief five-second heads-up handoff expires independently; later refreshes cannot extend it. Alarm delivery rechecks the current schedule rather than trusting an old alarm's title, room or time. A refresh that races a due alarm delivers that validated pending reminder once before replacing the future schedule.

**Live class updates** automatically follows one imminent or active class, exam or office hour. It starts within ten minutes of the activity, carries the room and a countdown to the start, then counts down to the end. It is enabled by default and can be turned off in Settings → Notifications. Dismissing or choosing **Unpin** hides that occurrence through subsequent refreshes and restarts. Future activities remain eligible. Nothing is kept visible between activities.

During an active activity, Android 16+ uses the system progress style to show how much of the scheduled time has elapsed. The bar describes elapsed class time, not completion of coursework. The next commitment's actual title, date/time and room appear in the subtext when available. Before the activity starts, and on older Android versions, the expanded text includes up to three future classes, exams, office hours or deadlines in chronological order; the older active fallback also has a progress bar. Date-only deadlines retain their date without inventing a due time. The current occurrence, duplicates, cancellations, stale events and passed commitments are excluded. Fresh schedule changes update the same notification silently. An empty agenda adds no generic “next task” or empty-list message.

Android owns the pill interaction and card expansion. On the ordinary-notification fallback, tap the expansion indicator or swipe down on the notification to reveal details; tapping its body opens the app. The implementation uses `ProgressStyle` for active tracking on API 36+ and `BigTextStyle` for the other states. There is no custom notification view or separate notification for each upcoming activity.

Selection excludes replaced, all-day, invalid and stale events. Cached calendars are usable for at most 24 hours, with five minutes of future clock-skew tolerance: a saved `live` state does not make old evidence permanently fresh. Schedule changes are reconciled against the latest usable calendar. Cancellation, expiry, disabling tracking and disconnecting all remove the tracker and its scheduled transitions.

The countdown is rendered by Android's notification chronometer. The app schedules transitions at event, agenda and expiry boundaries, plus inexact progress updates at most every five minutes during an active activity. These updates use the saved calendar and make no API or AI call. There is no permanent foreground service or per-second wakeup. Periodic sync and boot restoration reconcile the schedule. Without exact-alarm access, Android can delay a transition; the receiver checks expiry again and the notification timeout independently bounds its lifetime.

On Android 16 (API 36) and later, the app requests a promoted ongoing notification and declares `POST_PROMOTED_NOTIFICATIONS`. The system can show its countdown in a status-bar chip. Older phones and phones with promotion disabled use an ordinary ongoing notification. Permission, channel settings, device support and system eligibility determine the final presentation; the app cannot force a pill or arbitrary status-bar text. System notification settings and the app's automatic-tracking preference remain independent.

Android reserves Live Updates for ongoing, time-sensitive monitoring. Automatic class monitoring is restricted to the imminent/active attendance window, with a visible opt-out and per-occurrence dismissal. Long-range calendar entries, pending assignments and ambient dashboard status do not request promotion.

Primary references:

- [Live Update eligibility, timing, status chips and dismissal](https://developer.android.com/develop/ui/views/notifications/live-update)
- [Notification expansion and body-tap behavior](https://developer.android.com/design/ui/mobile/guides/home-screen/notifications)
- [NotificationCompat promotion, chronometer and timeout APIs](https://developer.android.com/reference/androidx/core/app/NotificationCompat.Builder)
- [Promotion permission check](https://developer.android.com/reference/android/app/NotificationManager#canPostPromotedNotifications())
- [Promotion settings on API 36](https://developer.android.com/reference/android/provider/Settings#ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS)
- [Alarm timing and exact-alarm access](https://developer.android.com/develop/background-work/services/alarms)

Device verification should cover an imminent class becoming active, the next-three list (including long titles and a next-day deadline), a room/time change, cancellation, overlapping events, expiry while offline, reboot, Unpin, permission/channel denial, disabled automatic tracking, sign-out and a second sign-in. Check API 29/33 fallback expansion and API 36+ promotion separately; system promotion is a device behavior, not a pure planning-test assertion.
