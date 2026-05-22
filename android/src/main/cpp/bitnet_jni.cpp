// bitnet_jni.cpp
//
// JNI glue between BitnetModule.kt and bitnet::BitnetEngine. Each JNI function
// is a thin wrapper that:
//   1. Translates JNI types (jstring, jlong) to C++ types
//   2. Calls into the engine
//   3. Translates results back
//
// Engine handles are passed as jlong, reinterpret_cast from BitnetEngine*.
// We deliberately leak the engine across the JNI boundary — Kotlin owns the
// lifetime via the handle, and nativeDisposeEngine deletes it.

#include <jni.h>

#include <atomic>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "bitnet_engine.h"

// --------------------------------------------------------------------------
// Handle bookkeeping. We use a map keyed by handle so we can validate that
// a Long passed from Kotlin still corresponds to a live engine — protects
// against use-after-dispose.
// --------------------------------------------------------------------------

namespace {

struct EngineRegistry {
    std::mutex mu;
    std::unordered_map<jlong, std::unique_ptr<bitnet::BitnetEngine>> engines;
    std::atomic<jlong> next_id{1};

    jlong insert(std::unique_ptr<bitnet::BitnetEngine> engine) {
        std::lock_guard<std::mutex> lock(mu);
        const jlong id = next_id.fetch_add(1);
        engines.emplace(id, std::move(engine));
        return id;
    }

    bitnet::BitnetEngine* get(jlong id) {
        std::lock_guard<std::mutex> lock(mu);
        auto it = engines.find(id);
        return it == engines.end() ? nullptr : it->second.get();
    }

    void remove(jlong id) {
        std::lock_guard<std::mutex> lock(mu);
        engines.erase(id);
    }
};

EngineRegistry& registry() {
    static EngineRegistry instance;
    return instance;
}

// Convert jstring → std::string with UTF-8 byte handling.
std::string j2s(JNIEnv* env, jstring jstr) {
    if (!jstr) return {};
    const char* chars = env->GetStringUTFChars(jstr, nullptr);
    std::string result(chars ? chars : "");
    if (chars) env->ReleaseStringUTFChars(jstr, chars);
    return result;
}

// Map a C++ FinishReason to the JS string our public API exposes.
// OpenAI parity: EndOfSequence and StopSequence both collapse to "stop".
// "cancelled" and "error" are on-device-specific extensions.
const char* finish_reason_to_string(bitnet::FinishReason r) {
    switch (r) {
        case bitnet::FinishReason::Length:        return "length";
        case bitnet::FinishReason::EndOfSequence: return "stop";
        case bitnet::FinishReason::StopSequence:  return "stop";
        case bitnet::FinishReason::Cancelled:     return "cancelled";
        case bitnet::FinishReason::Error:         return "error";
    }
    return "error";  // unreachable; keeps the compiler happy
}

// JSON-escape a single value (used for getModelInfo, which returns JSON).
std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    return out;
}

// Helper: parse a single hex digit. Returns -1 if not a hex digit.
inline int hex_digit(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return 10 + (c - 'a');
    if (c >= 'A' && c <= 'F') return 10 + (c - 'A');
    return -1;
}

// Helper: append a Unicode codepoint as UTF-8 bytes.
inline void append_utf8(std::string& s, uint32_t cp) {
    if (cp < 0x80) {
        s += static_cast<char>(cp);
    } else if (cp < 0x800) {
        s += static_cast<char>(0xC0 | (cp >> 6));
        s += static_cast<char>(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
        s += static_cast<char>(0xE0 | (cp >> 12));
        s += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        s += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
        s += static_cast<char>(0xF0 | (cp >> 18));
        s += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
        s += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        s += static_cast<char>(0x80 | (cp & 0x3F));
    }
}

// Read one JSON string value starting at json[i]. Advances i past the closing
// quote. Returns empty string if the cursor is not on a '"'. Used by both
// parse_messages and parse_string_array. Handles the escape sequences
// JSON.stringify can actually emit: \" \\ \n \t \r and \uXXXX (with surrogate
// pair recombination for codepoints outside the BMP).
std::string read_json_string(const std::string& json, size_t& i) {
    while (i < json.size() && std::isspace((unsigned char)json[i])) ++i;
    if (i >= json.size() || json[i] != '"') return {};
    ++i;
    std::string s;
    while (i < json.size() && json[i] != '"') {
        if (json[i] == '\\' && i + 1 < json.size()) {
            const char esc = json[i + 1];
            if (esc == 'u' && i + 5 < json.size()) {
                // \uXXXX → 4 hex digits, encoding a Unicode codepoint. If the
                // codepoint is a high surrogate (0xD800-0xDBFF) and the next
                // 6 chars are another \uXXXX in the low-surrogate range, we
                // combine them into a single supplementary-plane codepoint.
                const int d0 = hex_digit(json[i + 2]);
                const int d1 = hex_digit(json[i + 3]);
                const int d2 = hex_digit(json[i + 4]);
                const int d3 = hex_digit(json[i + 5]);
                if (d0 < 0 || d1 < 0 || d2 < 0 || d3 < 0) {
                    // Malformed escape — copy the literal `u` and bail.
                    s += 'u';
                    i += 2;
                    continue;
                }
                uint32_t cp = (static_cast<uint32_t>(d0) << 12) |
                              (static_cast<uint32_t>(d1) << 8)  |
                              (static_cast<uint32_t>(d2) << 4)  |
                              static_cast<uint32_t>(d3);
                i += 6;
                if (cp >= 0xD800 && cp <= 0xDBFF && i + 5 < json.size()
                    && json[i] == '\\' && json[i + 1] == 'u') {
                    const int e0 = hex_digit(json[i + 2]);
                    const int e1 = hex_digit(json[i + 3]);
                    const int e2 = hex_digit(json[i + 4]);
                    const int e3 = hex_digit(json[i + 5]);
                    if (e0 >= 0 && e1 >= 0 && e2 >= 0 && e3 >= 0) {
                        const uint32_t low =
                            (static_cast<uint32_t>(e0) << 12) |
                            (static_cast<uint32_t>(e1) << 8)  |
                            (static_cast<uint32_t>(e2) << 4)  |
                            static_cast<uint32_t>(e3);
                        if (low >= 0xDC00 && low <= 0xDFFF) {
                            cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                            i += 6;
                        }
                    }
                }
                append_utf8(s, cp);
                continue;
            }
            switch (esc) {
                case 'n': s += '\n'; break;
                case 't': s += '\t'; break;
                case 'r': s += '\r'; break;
                case '"': s += '"'; break;
                case '\\': s += '\\'; break;
                default: s += esc; break;
            }
            i += 2;
        } else {
            s += json[i++];
        }
    }
    if (i < json.size()) ++i;  // consume closing quote
    return s;
}

// Parse a JSON array of strings into a vector<std::string>. Empty / invalid
// input returns an empty vector. Used for the stop-sequences param.
std::vector<std::string> parse_string_array(const std::string& json) {
    std::vector<std::string> result;
    size_t i = 0;
    auto skip_ws = [&]() { while (i < json.size() && std::isspace((unsigned char)json[i])) ++i; };

    skip_ws();
    if (i >= json.size() || json[i] != '[') return result;
    ++i;
    skip_ws();
    if (i < json.size() && json[i] == ']') return result;

    while (i < json.size()) {
        std::string s = read_json_string(json, i);
        result.push_back(std::move(s));
        skip_ws();
        if (i >= json.size()) break;
        if (json[i] == ',') { ++i; skip_ws(); continue; }
        if (json[i] == ']') break;
    }
    return result;
}

// Parse a JSON array of {role, content} into a vector<ChatMessage>.
// Deliberately minimal — we don't ship a JSON library; the input shape
// is fully controlled by our own TS layer.
std::vector<bitnet::ChatMessage> parse_messages(const std::string& json) {
    std::vector<bitnet::ChatMessage> result;

    size_t i = 0;
    auto skip_ws = [&]() { while (i < json.size() && std::isspace((unsigned char)json[i])) ++i; };
    auto expect = [&](char c) -> bool { skip_ws(); return i < json.size() && json[i++] == c; };

    if (!expect('[')) return result;
    skip_ws();
    if (i < json.size() && json[i] == ']') return result;

    while (i < json.size()) {
        skip_ws();
        if (!expect('{')) break;

        bitnet::ChatMessage msg;
        for (int field = 0; field < 2; ++field) {
            skip_ws();
            std::string key = read_json_string(json, i);
            skip_ws();
            if (i >= json.size() || json[i] != ':') break;
            ++i;
            std::string value = read_json_string(json, i);
            if (key == "role") msg.role = value;
            else if (key == "content") msg.content = value;
            skip_ws();
            if (i < json.size() && json[i] == ',') ++i;
        }
        skip_ws();
        if (i < json.size() && json[i] == '}') ++i;

        result.push_back(std::move(msg));

        skip_ws();
        if (i >= json.size()) break;
        if (json[i] == ',') { ++i; continue; }
        if (json[i] == ']') break;
    }

    return result;
}

}  // namespace

// --------------------------------------------------------------------------
// JNI function symbols.
//
// Naming convention: Java_<package>_<class>_<method>, with dots as underscores
// and underscores as _1. Our class is com.bitnet.BitnetModule.
// --------------------------------------------------------------------------

extern "C" {

JNIEXPORT jlong JNICALL
Java_com_bitnet_BitnetModule_nativeLoadModel(
    JNIEnv* env, jobject /*thiz*/,
    jstring modelPath, jint nCtx, jint nThreads, jint nBatch)
{
    try {
        bitnet::EngineConfig config;
        config.model_path = j2s(env, modelPath);
        config.n_ctx      = nCtx;
        config.n_threads  = nThreads;
        config.n_batch    = nBatch;

        auto engine = bitnet::BitnetEngine::create(config);
        if (!engine) return 0;
        return registry().insert(std::move(engine));
    } catch (const std::exception& e) {
        jclass exc = env->FindClass("java/lang/RuntimeException");
        if (exc) env->ThrowNew(exc, e.what());
        return 0;
    }
}

JNIEXPORT jstring JNICALL
Java_com_bitnet_BitnetModule_nativeGenerate(
    JNIEnv* env, jobject thiz,
    jlong handle, jlong requestId, jstring jPrompt,
    jint maxTokens, jfloat temperature, jint topK, jfloat topP, jint seed,
    jstring jStopSequencesJson,
    jfloat repeatPenalty, jint repeatLastN,
    jfloat frequencyPenalty, jfloat presencePenalty)
{
    auto* engine = registry().get(handle);
    if (!engine) {
        jclass exc = env->FindClass("java/lang/IllegalStateException");
        if (exc) env->ThrowNew(exc, "engine handle is invalid (disposed?)");
        return nullptr;
    }

    try {
        bitnet::GenerationParams params;
        params.max_tokens         = maxTokens;
        params.temperature        = temperature;
        params.top_k              = topK;
        params.top_p              = topP;
        params.seed               = static_cast<uint32_t>(seed);
        params.repeat_penalty     = repeatPenalty;
        params.repeat_last_n      = repeatLastN;
        params.frequency_penalty  = frequencyPenalty;
        params.presence_penalty   = presencePenalty;
        params.stop_sequences     = parse_string_array(j2s(env, jStopSequencesJson));

        // Resolve the emitToken Java method on this BitnetModule instance.
        // Signature is (JJLjava/lang/String;)V — handle, requestId, token.
        jclass cls = env->GetObjectClass(thiz);
        jmethodID emitMethod = env->GetMethodID(
            cls, "emitToken", "(JJLjava/lang/String;)V");

        // Hold the JNIEnv* in a lambda capture — note this is the JS thread's
        // JNIEnv (we're called from a worker thread spawned by Kotlin). Calls
        // back into Kotlin from this thread are safe because Kotlin's Thread
        // attached us when invoking native methods.

        auto result = engine->generate(
            j2s(env, jPrompt),
            params,
            [&](const std::string& piece) {
                if (emitMethod) {
                    jstring jPiece = env->NewStringUTF(piece.c_str());
                    env->CallVoidMethod(thiz, emitMethod, handle, requestId, jPiece);
                    env->DeleteLocalRef(jPiece);

                    // Surface any exception thrown by emitToken as an early
                    // stop signal — same effect as the user calling cancel().
                    if (env->ExceptionCheck()) {
                        env->ExceptionClear();
                        return bitnet::CallbackResult::Stop;
                    }
                }
                return bitnet::CallbackResult::Continue;
            });

        // Encode the full GenerationResult as JSON. Kotlin parses it and
        // resolves with a structured WritableNativeMap — same pattern as
        // nativeGetModelInfo below. We avoid building a WritableMap directly
        // here to keep this layer free of React Native types.
        std::string json;
        json.reserve(result.text.size() + 128);
        json += "{";
        json += "\"text\":\"";        json += json_escape(result.text);                           json += "\",";
        json += "\"finishReason\":\""; json += finish_reason_to_string(result.finish_reason);     json += "\",";
        json += "\"promptTokens\":";   json += std::to_string(result.prompt_tokens);              json += ",";
        json += "\"completionTokens\":"; json += std::to_string(result.tokens_generated);         json += ",";
        json += "\"wallTimeMs\":";     json += std::to_string(result.wall_time_ms);
        json += "}";
        return env->NewStringUTF(json.c_str());

    } catch (const std::exception& e) {
        jclass exc = env->FindClass("java/lang/RuntimeException");
        if (exc) env->ThrowNew(exc, e.what());
        return nullptr;
    }
}

JNIEXPORT void JNICALL
Java_com_bitnet_BitnetModule_nativeCancelGeneration(
    JNIEnv* /*env*/, jobject /*thiz*/, jlong handle)
{
    auto* engine = registry().get(handle);
    if (engine) engine->cancel();
}

JNIEXPORT jstring JNICALL
Java_com_bitnet_BitnetModule_nativeApplyChatTemplate(
    JNIEnv* env, jobject /*thiz*/,
    jlong handle, jstring jRolesJson, jboolean addAssistantHeader)
{
    auto* engine = registry().get(handle);
    if (!engine) {
        jclass exc = env->FindClass("java/lang/IllegalStateException");
        if (exc) env->ThrowNew(exc, "engine handle is invalid (disposed?)");
        return nullptr;
    }

    try {
        const std::string json = j2s(env, jRolesJson);
        auto messages = parse_messages(json);
        std::string rendered = engine->apply_chat_template(messages, addAssistantHeader);
        return env->NewStringUTF(rendered.c_str());
    } catch (const std::exception& e) {
        jclass exc = env->FindClass("java/lang/RuntimeException");
        if (exc) env->ThrowNew(exc, e.what());
        return nullptr;
    }
}

JNIEXPORT jstring JNICALL
Java_com_bitnet_BitnetModule_nativeGetModelInfo(
    JNIEnv* env, jobject /*thiz*/, jlong handle)
{
    auto* engine = registry().get(handle);
    if (!engine) {
        jclass exc = env->FindClass("java/lang/IllegalStateException");
        if (exc) env->ThrowNew(exc, "engine handle is invalid (disposed?)");
        return nullptr;
    }

    try {
        auto info = engine->model_info();
        std::string json;
        json.reserve(256);
        json += "{";
        json += "\"architecture\":\"" + json_escape(info.architecture) + "\",";
        json += "\"nVocab\":"         + std::to_string(info.n_vocab) + ",";
        json += "\"nCtxTrain\":"      + std::to_string(info.n_ctx_train) + ",";
        json += "\"nEmbd\":"          + std::to_string(info.n_embd) + ",";
        json += "\"modelSizeBytes\":" + std::to_string(info.model_size_bytes);
        json += "}";
        return env->NewStringUTF(json.c_str());
    } catch (const std::exception& e) {
        jclass exc = env->FindClass("java/lang/RuntimeException");
        if (exc) env->ThrowNew(exc, e.what());
        return nullptr;
    }
}

JNIEXPORT void JNICALL
Java_com_bitnet_BitnetModule_nativeDisposeEngine(
    JNIEnv* /*env*/, jobject /*thiz*/, jlong handle)
{
    registry().remove(handle);
}

}  // extern "C"