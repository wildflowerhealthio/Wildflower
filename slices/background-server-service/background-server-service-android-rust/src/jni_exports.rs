//! The JNI functions `HeadlessBridge` declares as `external`
//! (`HeadlessBridge.kt`, `tauri-plugin-background-service` 1.0.1). Each is
//! `@JvmStatic` on a Kotlin `object` in `app.tauri.backgroundservice`, so it
//! binds to `Java_app_tauri_backgroundservice_HeadlessBridge_<name>` and takes
//! the class, not an instance.
//!
//! The one place in the workspace that allows `unsafe_code`, and only for the
//! `#[unsafe(no_mangle)]` that exports each function under its JNI name. The
//! functions themselves are safe: each builds its answer with
//! [`HeadlessCoreReport`] and hands it back as a Java string.

// The JNI names are fixed by the Kotlin declarations.
#![allow(non_snake_case)]

use crate::headless_core_report::HeadlessCoreReport;
use jni::objects::{JClass, JString};
use jni::sys::jstring;
use jni::JNIEnv;

/// `external fun startCore(dataDir: String, reason: String): String`
#[allow(unsafe_code)]
// SAFETY: the name is the JNI binding of `HeadlessBridge.startCore`, which no
// other symbol in the process defines, and the signature matches its Kotlin
// declaration.
#[unsafe(no_mangle)]
pub extern "system" fn Java_app_tauri_backgroundservice_HeadlessBridge_startCore<'local>(
    env: JNIEnv<'local>,
    _class: JClass<'local>,
    _data_dir: JString<'local>,
    _reason: JString<'local>,
) -> jstring {
    report_to_java(
        &env,
        &HeadlessCoreReport::for_start_core(crate::host_is_running()),
    )
}

/// `external fun stopCore(dataDir: String, reason: String): String`
#[allow(unsafe_code)]
// SAFETY: the name is the JNI binding of `HeadlessBridge.stopCore`, which no
// other symbol in the process defines, and the signature matches its Kotlin
// declaration.
#[unsafe(no_mangle)]
pub extern "system" fn Java_app_tauri_backgroundservice_HeadlessBridge_stopCore<'local>(
    env: JNIEnv<'local>,
    _class: JClass<'local>,
    _data_dir: JString<'local>,
    _reason: JString<'local>,
) -> jstring {
    report_to_java(&env, &HeadlessCoreReport::HostManaged)
}

/// `external fun notifyNetworkChanged(): String`
#[allow(unsafe_code)]
// SAFETY: the name is the JNI binding of `HeadlessBridge.notifyNetworkChanged`,
// which no other symbol in the process defines, and the signature matches its
// Kotlin declaration.
#[unsafe(no_mangle)]
pub extern "system" fn Java_app_tauri_backgroundservice_HeadlessBridge_notifyNetworkChanged<
    'local,
>(
    env: JNIEnv<'local>,
    _class: JClass<'local>,
) -> jstring {
    report_to_java(&env, &HeadlessCoreReport::HostManaged)
}

/// `external fun callAction(callId: String, action: String): String`
#[allow(unsafe_code)]
// SAFETY: the name is the JNI binding of `HeadlessBridge.callAction`, which no
// other symbol in the process defines, and the signature matches its Kotlin
// declaration.
#[unsafe(no_mangle)]
pub extern "system" fn Java_app_tauri_backgroundservice_HeadlessBridge_callAction<'local>(
    env: JNIEnv<'local>,
    _class: JClass<'local>,
    _call_id: JString<'local>,
    _action: JString<'local>,
) -> jstring {
    report_to_java(&env, &HeadlessCoreReport::NoCalls)
}

/// `external fun notificationAction(dataDir: String, action: String,
/// chatId: String, messageId: String, replyText: String): String`
#[allow(unsafe_code)]
// SAFETY: the name is the JNI binding of `HeadlessBridge.notificationAction`,
// which no other symbol in the process defines, and the signature matches its
// Kotlin declaration.
#[unsafe(no_mangle)]
pub extern "system" fn Java_app_tauri_backgroundservice_HeadlessBridge_notificationAction<
    'local,
>(
    env: JNIEnv<'local>,
    _class: JClass<'local>,
    _data_dir: JString<'local>,
    _action: JString<'local>,
    _chat_id: JString<'local>,
    _message_id: JString<'local>,
    _reply_text: JString<'local>,
) -> jstring {
    report_to_java(&env, &HeadlessCoreReport::NoMessageNotifications)
}

/// Hands `report`'s JSON back to Kotlin as a new Java string.
fn report_to_java(env: &JNIEnv, report: &HeadlessCoreReport) -> jstring {
    match env.new_string(report.to_json()) {
        Ok(report_json) => report_json.into_raw(),
        // `NewStringUTF` failed with its exception (an `OutOfMemoryError`)
        // pending; returning null throws it from the Kotlin call.
        Err(jni::errors::Error::JavaException) => std::ptr::null_mut(),
        // JNI's `NewStringUTF` fails only by throwing, so this is a broken JVM.
        Err(error) => env.fatal_error(format!(
            "background-server-service: failed to return a headless-core report: {error}"
        )),
    }
}
