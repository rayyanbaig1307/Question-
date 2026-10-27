import { router } from 'expo-router';
import { Alert } from 'react-native';

import { useOverlays } from '@/components/Overlays';
import { friendlyError } from './errors';
import { blockUser, REPORT_REASONS, reportContent } from './safety';
import type { ReportContentType } from './types';

// The "Report" and "Block" flows, shared by every screen that needs them.
export function useSafetyActions() {
  const { showOptions, showToast } = useOverlays();

  function confirmBlock(user: { id: string; username: string }, onBlocked?: () => void) {
    Alert.alert(
      `Block @${user.username}?`,
      "They won't be able to find your profile, see your posts or stories, or message you. We won't tell them.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            try {
              await blockUser(user.id);
              showToast(`Blocked @${user.username}`);
              if (onBlocked) onBlocked();
              else if (router.canGoBack()) router.back();
            } catch (error) {
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
    showOptions({
      title: 'Why are you reporting this?',
      message: "Your report is private. They won't know it was you.",
      options: REPORT_REASONS.map((reason) => ({
        label: reason,
        onPress: async () => {
          try {
            await reportContent({
              reportedUserId: params.user.id,
              contentType: params.contentType,
              contentId: params.contentId,
              reason,
            });
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
            Alert.alert('Could not send report', friendlyError(error));
          }
        },
      })),
    });
  }

  return { report, confirmBlock };
}
