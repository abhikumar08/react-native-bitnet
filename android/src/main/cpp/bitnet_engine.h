// bitnet_engine.h
//
// A C++ wrapper around llama.cpp providing a clean, platform-agnostic
// inference engine for BitNet models. This header is the entire public
// API of the engine layer — the JNI bridge (Android) and Objective-C++
// bridge (iOS) sit on top of this and nothing else.
//
// Design rationale:
//
//   - No JNI types, JSI types, or Android headers appear here. The engine
//     compiles and runs on any platform with a C++17 compiler. This lets
//     us unit-test the engine on desktop against the same code that runs
//     on the device, and lets a future iOS port reuse this unchanged.
//
//   - The pimpl idiom keeps llama.h out of this header. Whoever #includes
//     bitnet_engine.h does not transitively pick up all of llama.cpp's
//     types. That keeps build times sane and shields callers from
//     llama.cpp version churn.
//
//   - Streaming generation uses a std::function callback rather than any
//     coroutine / future / Flow abstraction. The engine doesn't know about
//     Kotlin coroutines or JS async iterators; higher layers adapt the
//     callback into their preferred idiom.
//
//   - Cancellation is via a separate cancel() method that flips an atomic
//     flag the decode loop checks every iteration. Safe to call from any
//     thread while generate() is in progress.
//
//   - Generation on a single BitnetEngine instance is single-threaded. The
//     underlying llama_context is not safe for concurrent calls; we make
//     the caller serialize externally or construct multiple engines.

#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace bitnet {

// ============================================================================
// Configuration types
// ============================================================================

/// Construction-time configuration. One per model load.
struct EngineConfig {
    /// Absolute path to the GGUF file on disk.
    std::string model_path;

    /// Context window size in tokens. 0 means use the model's training default.
    /// Larger means more memory but allows longer conversations / longer prompts.
    int n_ctx = 2048;

    /// CPU threads used for inference. 4 is a reasonable default on modern phones;
    /// going higher than the device's physical core count usually hurts due to
    /// cache contention.
    int n_threads = 4;

    /// Batch size for prompt processing. Larger values process the prompt faster
    /// but use more transient memory. Generation always uses batch size 1.
    int n_batch = 512;
};

/// Per-call generation parameters. Field names mirror the OpenAI API so that
/// developers migrating from OpenAI recognize them.
struct GenerationParams {
    /// Maximum number of tokens to generate. The engine stops sooner on EOS
    /// or stop-sequence match.
    int max_tokens = 256;

    /// Sampling temperature. 0.0 = greedy (deterministic), higher = more random.
    /// 0.7–1.0 is the typical creative-but-coherent range.
    float temperature = 0.8f;

    /// Top-K sampling: consider only the K most-probable tokens at each step.
    /// 0 disables top-K filtering.
    int top_k = 40;

    /// Top-P (nucleus) sampling: consider tokens whose cumulative probability
    /// exceeds P. 1.0 disables top-P filtering.
    float top_p = 0.95f;

    /// Penalty applied to tokens that recently appeared in the context. 1.0 = no
    /// penalty, > 1.0 reduces repetition.
    float repeat_penalty = 1.1f;

    /// How many recent tokens to consider for the repeat / frequency / presence
    /// penalties. 0 disables, -1 means "use the full context".
    int repeat_last_n = 64;

    /// OpenAI-style frequency penalty. 0.0 = disabled. Penalizes tokens
    /// proportionally to how often they have appeared in the recent window
    /// (sized by repeat_last_n).
    float frequency_penalty = 0.0f;

    /// OpenAI-style presence penalty. 0.0 = disabled. Penalizes tokens that
    /// have appeared at least once in the recent window, regardless of count.
    float presence_penalty = 0.0f;

    /// Strings that, when emitted, cause generation to stop. Matched against the
    /// accumulated output string (not individual tokens), so multi-token stop
    /// sequences work.
    std::vector<std::string> stop_sequences;

    /// RNG seed for sampling. 0 means the engine picks a fresh seed per call.
    /// Set explicitly for reproducible output during testing.
    uint32_t seed = 0;
};

// ============================================================================
// Output types
// ============================================================================

/// Reason a generate() call returned.
enum class FinishReason {
    /// Hit the max_tokens limit.
    Length,
    /// Model emitted an end-of-sequence token.
    EndOfSequence,
    /// One of the stop_sequences appeared in the output.
    StopSequence,
    /// User called cancel() on another thread, or the callback returned Stop.
    Cancelled,
    /// An error occurred mid-generation. Token emission may be partial.
    Error,
};

/// Returned by the token callback to control generation flow.
enum class CallbackResult {
    /// Keep generating.
    Continue,
    /// Stop generation cleanly. generate() will return with FinishReason::Cancelled.
    Stop,
};

/// Per-token streaming callback. Called once per generated token piece, on the
/// thread that invoked generate(). The argument is the *decoded text piece* for
/// the token (usually 1-5 characters; not a "word" per se, but a sub-word unit).
///
/// Returning Stop is the cooperative cancellation path. Calling
/// BitnetEngine::cancel() from a different thread is the preemptive one.
using TokenCallback = std::function<CallbackResult(const std::string& token_piece)>;

/// Final result of a generate() call.
struct GenerationResult {
    /// The full generated text, concatenated from all emitted pieces.
    std::string text;

    /// Why generation stopped.
    FinishReason finish_reason = FinishReason::Length;

    /// Number of tokens consumed from the input prompt (after tokenization).
    /// Surfaced to JS as `usage.promptTokens` for OpenAI-style accounting.
    int prompt_tokens = 0;

    /// Number of tokens actually generated (does not count the prompt).
    int tokens_generated = 0;

    /// Wall-clock time spent in this generate() call, in milliseconds.
    /// Useful for benchmarking and exposing via the SDK's telemetry API.
    int64_t wall_time_ms = 0;
};

/// Model introspection. Returned by BitnetEngine::model_info().
struct ModelInfo {
    /// Architecture string from GGUF metadata. e.g. "bitnet-b1.58" or "bitnet-25".
    std::string architecture;

    /// Vocabulary size.
    int n_vocab = 0;

    /// Maximum context length the model was trained with. Generation can use
    /// up to this many tokens; setting EngineConfig::n_ctx higher than this is
    /// allowed but degrades quality.
    int n_ctx_train = 0;

    /// Hidden dimension. Useful for debug logs, not normally exposed to SDK users.
    int n_embd = 0;

    /// Size of the model file on disk, in bytes.
    int64_t model_size_bytes = 0;
};

struct ChatMessage {
    std::string role;       // "user", "assistant", or "system"
    std::string content;
};

// ============================================================================
// The engine
// ============================================================================

/// Owns one llama_model, one llama_context, and the sampler state.
///
/// Lifecycle:
///   auto engine = BitnetEngine::create({.model_path = "..."});
///   engine->generate(prompt, params, [](const std::string& piece) {
///       std::cout << piece;
///       return bitnet::CallbackResult::Continue;
///   });
///   // engine destructor frees all llama.cpp resources in correct order
///
/// Thread safety:
///   - generate() is not safe to call concurrently on the same instance.
///   - cancel() is safe to call from any thread while generate() runs.
///   - model_info() is safe to call from any thread (it's a read of immutable
///     fields cached at construction time).
class BitnetEngine {
public:
    /// Construct an engine, loading the model from disk. Blocks until the
    /// model is fully loaded — typically 1–10 seconds depending on model
    /// size and device.
    ///
    /// Throws std::runtime_error on failure to load. The thrown exception's
    /// what() string is suitable for direct display to the developer (not the
    /// end user); the SDK layer wraps it into a typed error before exposing
    /// to TS.
    static std::unique_ptr<BitnetEngine> create(const EngineConfig& config);

    /// Releases the llama_model, llama_context, and sampler in the correct
    /// order. Safe to destruct from any thread, but not while generate() is
    /// running on another thread (call cancel() and wait for generate() to
    /// return first).
    ~BitnetEngine();

    // Non-copyable, non-movable. Owns native resources by raw pointer; making
    // this copyable or movable would require careful surgery we don't need.
    // Callers hold these via std::unique_ptr.
    BitnetEngine(const BitnetEngine&) = delete;
    BitnetEngine& operator=(const BitnetEngine&) = delete;
    BitnetEngine(BitnetEngine&&) = delete;
    BitnetEngine& operator=(BitnetEngine&&) = delete;

    /// Run streaming text generation.
    ///
    /// Tokenizes `prompt`, feeds it through the model, then samples tokens
    /// one at a time, calling `on_token` for each emitted piece. Returns
    /// when generation stops (see FinishReason for the conditions).
    ///
    /// Throws std::runtime_error only for unrecoverable engine errors. Normal
    /// stopping conditions (EOS, length limit, cancel) return cleanly.
    GenerationResult generate(
        const std::string& prompt,
        const GenerationParams& params,
        const TokenCallback& on_token);

    /// Signal an in-progress generate() call to stop. Returns immediately; the
    /// generate() call will exit at the next token boundary with
    /// FinishReason::Cancelled. Safe to call from any thread.
    ///
    /// If no generation is in progress, this call has no effect.
    void cancel();

    /// Returns metadata about the loaded model. Cheap; cached at construction.
    ModelInfo model_info() const;

    /// Render a list of chat messages into the prompt string format the model
    /// was trained on. Uses the model's built-in chat template from GGUF metadata.
    /// Throws std::runtime_error if the model has no usable template.
    std::string apply_chat_template(
        const std::vector<ChatMessage>& messages,
        bool add_assistant_header = true) const;

private:
    BitnetEngine();  // private — use create()

    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace bitnet
