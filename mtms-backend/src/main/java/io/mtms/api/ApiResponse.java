package io.mtms.api;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Map;

/**
 * The response envelope: {@code {data, meta}} on success, {@code {error: {code, message,
 * details}}} on failure.
 *
 * <p>Every response is wrapped, including the ones where the envelope looks like ceremony. A
 * client that can rely on the shape needs one response handler; a client facing bare objects on
 * success and a wrapped error on failure needs two, and gets the second one subtly wrong.
 *
 * <p>The code is the contract, not the message. Clients switch on {@code error.code}; the
 * message is prose for a human and may be reworded without warning.
 */
public final class ApiResponse {

  private ApiResponse() {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Success<T>(T data, Map<String, Object> meta) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Failure(Error error) {

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Error(String code, String message, Object details) {}
  }

  public static <T> Success<T> ok(T data) {
    return new Success<>(data, null);
  }

  public static <T> Success<T> ok(T data, Map<String, Object> meta) {
    return new Success<>(data, meta);
  }

  public static Failure error(String code, String message, Object details) {
    return new Failure(new Failure.Error(code, message, details));
  }
}
