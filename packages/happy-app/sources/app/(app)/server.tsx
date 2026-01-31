import { useState } from 'react';
import { View, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { Stack } from 'expo-router';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { RoundButton } from '@/components/RoundButton';
import { Modal } from '@/modal';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { getServerUrl, setServerUrl, validateServerUrl, getServerInfo } from '@/sync/serverConfig';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

const stylesheet = StyleSheet.create((theme) => ({
    keyboardAvoidingView: {
        flex: 1,
    },
    itemListContainer: {
        flex: 1,
    },
    contentContainer: {
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 16,
        paddingVertical: 12,
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
    },
    labelText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 8,
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        padding: 12,
        borderRadius: 8,
        marginBottom: 8,
        ...Typography.mono(),
        fontSize: 14,
        color: theme.colors.input.text,
    },
    textInputValidating: {
        opacity: 0.6,
    },
    errorText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textDestructive,
        marginBottom: 12,
    },
    validatingText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.status.connecting,
        marginBottom: 12,
    },
    buttonRow: {
        flexDirection: 'row',
        gap: 12,
        marginBottom: 12,
    },
    buttonWrapper: {
        flex: 1,
    },
    statusText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
}));

export default function ServerConfigScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const serverInfo = getServerInfo();
    const [inputUrl, setInputUrl] = useState(serverInfo.isCustom ? getServerUrl() : '');
    const [error, setError] = useState<string | null>(null);
    const [isValidating, setIsValidating] = useState(false);

    const validateServer = async (url: string): Promise<boolean> => {
        console.log('[Server Validation] ========== START ==========');
        console.log('[Server Validation] URL:', url);
        console.log('[Server Validation] Platform:', Platform.OS);
        console.log('[Server Validation] Timestamp:', new Date().toISOString());

        try {
            setIsValidating(true);
            setError(null);

            console.log('[Server Validation] Starting fetch request...');
            console.log('[Server Validation] Fetch options:', {
                method: 'GET',
                headers: { 'Accept': 'text/plain' }
            });

            const fetchStartTime = Date.now();
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'text/plain'
                }
            });
            const fetchDuration = Date.now() - fetchStartTime;

            console.log('[Server Validation] Fetch completed in', fetchDuration, 'ms');
            console.log('[Server Validation] Response status:', response.status);
            console.log('[Server Validation] Response statusText:', response.statusText);
            console.log('[Server Validation] Response ok:', response.ok);
            console.log('[Server Validation] Response headers:', JSON.stringify({
                'content-type': response.headers.get('content-type'),
                'content-length': response.headers.get('content-length'),
                'server': response.headers.get('server')
            }));

            if (!response.ok) {
                console.error('[Server Validation] Server returned error status:', response.status);
                setError(t('server.serverReturnedError'));
                return false;
            }

            console.log('[Server Validation] Reading response text...');
            const text = await response.text();
            console.log('[Server Validation] Response text length:', text.length);
            console.log('[Server Validation] Response text preview:', text.substring(0, 100));
            console.log('[Server Validation] Full response text:', text);

            if (!text.includes('Welcome to Happy Server!')) {
                console.error('[Server Validation] Response does not contain expected text');
                console.error('[Server Validation] Expected: "Welcome to Happy Server!"');
                console.error('[Server Validation] Got:', text);
                setError(t('server.notValidHappyServer'));
                return false;
            }

            console.log('[Server Validation] ✅ Validation successful!');
            return true;
        } catch (err) {
            console.error('[Server Validation] ========== ERROR ==========');
            console.error('[Server Validation] Caught exception:', err);
            console.error('[Server Validation] Error type:', err instanceof Error ? err.constructor.name : typeof err);
            console.error('[Server Validation] Error name:', err instanceof Error ? err.name : 'N/A');
            console.error('[Server Validation] Error message:', err instanceof Error ? err.message : String(err));
            console.error('[Server Validation] Error stack:', err instanceof Error ? err.stack : 'N/A');

            // Try to extract more details from the error
            if (err && typeof err === 'object') {
                console.error('[Server Validation] Error object keys:', Object.keys(err));
                console.error('[Server Validation] Error object:', JSON.stringify(err, null, 2));
            }

            console.error('[Server Validation] URL that failed:', url);
            console.error('[Server Validation] ========== END ERROR ==========');

            setError(t('server.failedToConnectToServer'));
            return false;
        } finally {
            setIsValidating(false);
            console.log('[Server Validation] ========== END ==========');
        }
    };

    const handleSave = async () => {
        console.log('[handleSave] ========== START ==========');
        console.log('[handleSave] Input URL:', inputUrl);
        console.log('[handleSave] Trimmed URL:', inputUrl.trim());

        if (!inputUrl.trim()) {
            console.log('[handleSave] URL is empty, showing alert');
            Modal.alert(t('common.error'), t('server.enterServerUrl'));
            return;
        }

        console.log('[handleSave] Validating URL format...');
        const validation = validateServerUrl(inputUrl);
        console.log('[handleSave] URL validation result:', validation);

        if (!validation.valid) {
            console.error('[handleSave] URL validation failed:', validation.error);
            setError(validation.error || t('errors.invalidFormat'));
            return;
        }

        console.log('[handleSave] URL format is valid, starting server validation...');
        // Validate the server
        const isValid = await validateServer(inputUrl);
        console.log('[handleSave] Server validation result:', isValid);

        if (!isValid) {
            console.log('[handleSave] Server validation failed, stopping');
            return;
        }

        console.log('[handleSave] Server validation passed, showing confirmation dialog');
        const confirmed = await Modal.confirm(
            t('server.changeServer'),
            t('server.continueWithServer'),
            { confirmText: t('common.continue'), destructive: true }
        );
        console.log('[handleSave] User confirmation:', confirmed);

        if (confirmed) {
            console.log('[handleSave] Saving server URL:', inputUrl);
            setServerUrl(inputUrl);
            console.log('[handleSave] Server URL saved successfully');
        } else {
            console.log('[handleSave] User cancelled');
        }

        console.log('[handleSave] ========== END ==========');
    };

    const handleReset = async () => {
        const confirmed = await Modal.confirm(
            t('server.resetToDefault'),
            t('server.resetServerDefault'),
            { confirmText: t('common.reset'), destructive: true }
        );

        if (confirmed) {
            setServerUrl(null);
            setInputUrl('');
        }
    };

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: t('server.serverConfiguration'),
                    headerBackTitle: t('common.back'),
                }}
            />

            <KeyboardAvoidingView 
                style={styles.keyboardAvoidingView}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <ItemList style={styles.itemListContainer}>
                    <ItemGroup footer={t('server.advancedFeatureFooter')}>
                        <View style={styles.contentContainer}>
                            <Text style={styles.labelText}>{t('server.customServerUrlLabel').toUpperCase()}</Text>
                            <TextInput
                                style={[
                                    styles.textInput,
                                    isValidating && styles.textInputValidating
                                ]}
                                value={inputUrl}
                                onChangeText={(text) => {
                                    setInputUrl(text);
                                    setError(null);
                                }}
                                placeholder={t('common.urlPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="none"
                                autoCorrect={false}
                                keyboardType="url"
                                editable={!isValidating}
                            />
                            {error && (
                                <Text style={styles.errorText}>
                                    {error}
                                </Text>
                            )}
                            {isValidating && (
                                <Text style={styles.validatingText}>
                                    {t('server.validatingServer')}
                                </Text>
                            )}
                            <View style={styles.buttonRow}>
                                <View style={styles.buttonWrapper}>
                                    <RoundButton
                                        title={t('server.resetToDefault')}
                                        size="normal"
                                        display="inverted"
                                        onPress={handleReset}
                                    />
                                </View>
                                <View style={styles.buttonWrapper}>
                                    <RoundButton
                                        title={isValidating ? t('server.validating') : t('common.save')}
                                        size="normal"
                                        action={handleSave}
                                        disabled={isValidating}
                                    />
                                </View>
                            </View>
                            {serverInfo.isCustom && (
                                <Text style={styles.statusText}>
                                    {t('server.currentlyUsingCustomServer')}
                                </Text>
                            )}
                        </View>
                    </ItemGroup>

                    </ItemList>
            </KeyboardAvoidingView>
        </>
    );
}
