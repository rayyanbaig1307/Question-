import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';

import { useOverlays } from '@/components/Overlays';
import { useAuth } from './auth';
import { friendlyError } from './errors';
import { blockUser, REPORT_REASONS, reportContent } from './safety';
import type { ReportContentType } from './types';

// The "Report" and "Block" flows, shared by every screen that needs them.
export function useSafetyActions() {
  const { showOptions, showToast } = useOverlays();
  const { userId } = useAuth();
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  function confirmBlock(user: { id: string; username: string }, onBlocked?: () => void) {
    if (!active.current || !userId) return;
    Alert.alert(
      `Block @${user.username}?`,
      "They won't be able to find your profile, see your posts or stories, or message you. We won't tell them.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            if (!active.current) return;
            try {
              await blockUser(user.id, userId);
              if (!active.current) return;
              showToast(`Blocked @${user.username}`);
              if (onBlocked) onBlocked();
              else if (router.canGoBack()) router.back();
            } catch (error) {
              if (!active.current) return;
              Alert.alert('Could not block', friendlyError(error));
            }
          },
        },
      ],
    );
  }

  function report(params: {
    user: { id: string; username: string };
    contentType: ReportContentType;
    contentId?: string;
    onBlocked?: () => void;
  }) {
    if (!active.current || !userId) return;
    showOptions({
      title: 'Why are you reporting this?',
      message: "Your report is private – they won't know it was you. We review every report within 24 hours.",
      options: REPORT_REASONS.map((reason) => ({
        label: reason.label,
        onPress: async () => {
          if (!active.current) return;
          try {
            await reportContent({
              reporterUserId: userId,
              reportedUserId: params.user.id,
              contentType: params.contentType,
              contentId: params.contentId,
              reason: reason.code,
            });
            if (!active.current) return;
            Alert.alert('Thanks for telling us 💛', 'We will take a look. Do you also want to block them?', [
              { text: 'Not now', style: 'cancel' },
              {
                text: 'Block',
                style: 'destructive',
                // Wait for this pop-up to close before opening the next one.
                onPress: () => setTimeout(() => confirmBlock(params.user, params.onBlocked), 400),
              },
            ]);
          } catch (error) {
            if (!active.current) return;
            Alert.alert('Could not send report', friendlyError(error));
          }
        },
      })),
    });
  }

  return { report, confirmBlock };
}
