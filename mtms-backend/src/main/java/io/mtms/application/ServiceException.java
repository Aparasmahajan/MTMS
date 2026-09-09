package io.mtms.application;

/**
 * The one exception the application layer throws, carrying a code the HTTP boundary maps to a
 * status.
 *
 * <p>A port of {@code lib/server/errors.ts}. The code is the contract — {@code
 * ApiExceptionHandler} turns it into a status and a {@code {error: {code, message}}} body, and
 * the client switches on the code rather than on prose that may be reworded.
 *
 * <p>Messages here are written for the person who will read them on screen. "That module
 * already exists in this project" tells somebody what to do next; "constraint violation" does
 * not.
 */
public class ServiceException extends RuntimeException {

  public enum Code {
    UNAUTHENTICATED(401),
    FORBIDDEN(403),
    NOT_FOUND(404),
    CONFLICT(409),
    VALIDATION_FAILED(422),
    BAD_REQUEST(400),
    RATE_LIMITED(429),
    INTERNAL(500);

    private final int status;

    Code(int status) {
      this.status = status;
    }

    public int status() {
      return status;
    }

    /** The wire form: lowercase snake_case, as the TypeScript service emits it. */
    public String wire() {
      return name().toLowerCase();
    }
  }

  private final Code code;
  private final transient Object details;

  public ServiceException(Code code, String message) {
    this(code, message, null);
  }

  public ServiceException(Code code, String message, Object details) {
    super(message);
    this.code = code;
    this.details = details;
  }

  public Code code() {
    return code;
  }

  public Object details() {
    return details;
  }

  // Convenience constructors — these read better at the call site than `new ServiceException(
  // ServiceException.Code.NOT_FOUND, ...)` does, and they are used often enough to matter.

  public static ServiceException notFound(String message) {
    return new ServiceException(Code.NOT_FOUND, message);
  }

  public static ServiceException conflict(String message) {
    return new ServiceException(Code.CONFLICT, message);
  }

  public static ServiceException validation(String message) {
    return new ServiceException(Code.VALIDATION_FAILED, message);
  }

  public static ServiceException badRequest(String message) {
    return new ServiceException(Code.BAD_REQUEST, message);
  }

  public static ServiceException forbidden(String message) {
    return new ServiceException(Code.FORBIDDEN, message);
  }
}
