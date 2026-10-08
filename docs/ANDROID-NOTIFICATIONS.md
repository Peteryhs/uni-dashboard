# Android reminders and live class updates

Class reminders use one replaceable notification slot, so successive classes do not leave a stack. Deadline lead reminders share an occurrence identity. Notifications expire no later than their event's end or deadline, and a calendar refresh removes obsolete reminders. When a live tracker replaces the matching class reminder, a brief five-second heads-up handoff expires independently; later refreshes cannot extend it. Alarm delivery rechecks the current schedule rather than trusting an old alarm's title, room or time. A refresh that races a due alarm delivers that validated pending reminder once before replacing the future schedule.

**Live class updates** automatically follows one imminent or active class, exam or office hour. It starts within ten minutes of the activity, carries the room and a countdown to the start, then counts down to the end. It is enabled by default and can be turned off in Settings → Notifications. Dismissing or choosing **Unpin** hides that occurrence through subsequent refreshes and restarts. Future activities remain eligible. Nothing is kept visible between activities.

The expanded card keeps the current activity above a **Next up** list of at most three future classes, exams, office hours or timed deadlines, in chronological order. Each entry includes its calendar-local date, time, title and room where available; deadlines are marked **Due**. The current occurrence, duplicates, cancellations, stale events, past starts and all-day entries are excluded. Fresh schedule changes update this same notification silently, and an activity starting or deadline becoming due advances the list. Fewer than three entries are shown when the usable calendar has fewer commitments. An empty list says **No more scheduled activities**.

Android owns the pill interaction and card expansion. On the ordinary-notification fallback, tap the expansion indicator or swipe down on the notification to reveal the list; tapping its body opens the app. The list uses `BigTextStyle`, a supported Live Update style, so no custom notification view or separate notification per upcoming activity is needed.

Selection excludes replaced, all-day, invalid and stale events. Cached calendars are usable for at most 24 hours, with five minutes of future clock-skew tolerance: a saved `live` state does not make old evidence permanently fresh. Schedule changes are reconciled against the latest usable calendar. Cancellation, expiry, disabling tracking and disconnecting all remove the tracker and its scheduled transitions.

The countdown is rendered by Android's notification chronometer. The app schedules transitions at meaningful boundaries rather than running a permanent foreground service or waking every second. Periodic sync and boot restoration reconcile the schedule. Without exact-alarm access, Android can delay a transition; the receiver checks expiry again and the notification timeout independently bounds its lifetime.

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
