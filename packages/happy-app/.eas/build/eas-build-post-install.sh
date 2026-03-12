#!/bin/bash

# 仅为 Android Preview 构建启用单架构优化以节省构建时间
if [ "$EAS_BUILD_PLATFORM" = "android" ] && [ "$APP_ENV" = "preview" ]; then
  echo "🚀 Configuring ARM64-only build to reduce build time..."
  echo "reactNativeArchitectures=arm64-v8a" >> android/gradle.properties
  echo "✅ Single architecture configuration complete"
  echo ""
  echo "📋 Updated gradle.properties:"
  cat android/gradle.properties | grep "reactNativeArchitectures"
fi
