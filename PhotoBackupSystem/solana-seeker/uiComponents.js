// PhotoLynk Mobile App - Reusable UI Components
// Extracted from App.js for cleaner code organization

import React, { useRef, useEffect } from 'react';
import { View, Animated, Easing, StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';

/**
 * Animated gradient spinner with pulsing effect
 * Used as loading indicator throughout the app
 */
export const GradientSpinner = ({ size = 80 }) => {
  const spinValue = useRef(new Animated.Value(0)).current;
  const pulseValue = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const spinAnimation = Animated.loop(
      Animated.timing(spinValue, {
        toValue: 1,
        duration: 2000,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );

    const pulseAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseValue, {
          toValue: 1,
          duration: 1000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulseValue, {
          toValue: 0,
          duration: 1000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );

    spinAnimation.start();
    pulseAnimation.start();

    return () => {
      spinAnimation.stop();
      pulseAnimation.stop();
    };
  }, [spinValue, pulseValue]);

  const rotate = spinValue.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const scale = pulseValue.interpolate({
    inputRange: [0, 1],
    outputRange: [0.9, 1.1],
  });

  // Photography-themed palette: warm reds → coral → gold → green → teal → violet → magenta → back to red
  const colors = [
    '#E53E3E', // red (photography warmth)
    '#E8634A', // coral-red
    '#F59E0B', // amber/gold
    '#EAB308', // warm gold
    '#22C55E', // green (nature)
    '#14B8A6', // teal
    '#6C5CE7', // violet
    '#A78BFA', // soft purple
    '#D946EF', // magenta
    '#EC4899', // pink
    '#F43F5E', // rose-red
    '#E53E3E', // wrap back to red
  ];
  const petalCount = 12;
  const petals = [];

  for (let i = 0; i < petalCount; i++) {
    const angle = (i * 360) / petalCount;
    petals.push(
      <View
        key={i}
        style={[
          spinnerStyles.petal,
          {
            backgroundColor: colors[i % colors.length],
            width: size * 0.22,
            height: size * 0.34,
            borderRadius: size * 0.11,
            transform: [
              { rotate: `${angle}deg` },
              { translateY: -size * 0.22 },
            ],
            opacity: 0.55 + (i / petalCount) * 0.45,
          },
        ]}
      />
    );
  }

  return (
    <Animated.View
      style={[
        spinnerStyles.container,
        {
          width: size,
          height: size,
          transform: [{ rotate }, { scale }],
        },
      ]}
    >
      {petals}
      <View
        style={[
          spinnerStyles.center,
          {
            width: size * 0.3,
            height: size * 0.3,
            borderRadius: size * 0.15,
          },
        ]}
      />
    </Animated.View>
  );
};

const spinnerStyles = StyleSheet.create({
  container: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  petal: {
    position: 'absolute',
  },
  center: {
    backgroundColor: 'transparent',
    position: 'absolute',
  },
});

/**
 * Glass card component with blur effect
 * Used for modal overlays and cards
 */
export const GlassCard = ({ children, style, glassEnabled, intensity = 80, tint = 'dark' }) => {
  if (!glassEnabled) {
    return (
      <View style={[glassStyles.fallbackCard, style]}>
        {children}
      </View>
    );
  }

  return (
    <BlurView intensity={intensity} tint={tint} style={[glassStyles.blurCard, style]}>
      {children}
    </BlurView>
  );
};

const glassStyles = StyleSheet.create({
  fallbackCard: {
    backgroundColor: 'rgba(10, 10, 20, 0.96)',
    borderRadius: 22,
    overflow: 'hidden',
  },
  blurCard: {
    borderRadius: 20,
    overflow: 'hidden',
  },
});
