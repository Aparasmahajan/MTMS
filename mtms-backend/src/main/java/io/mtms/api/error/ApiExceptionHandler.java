package io.mtms.api.error;

import io.mtms.api.ApiResponse;
import io.mtms.application.ServiceException;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

/**
 * Turns exceptions into the {@code {error: {code, message}}} envelope.
 *
 * <p>This is the only place in the service that decides an HTTP status. Controllers throw
 * {@link ServiceException} with a code and a sentence written for the person who will read it;
 * the mapping to 403 or 409 happens here, once.
 *
 * <p>The last handler is the important one. Anything unrecognised becomes a generic 500 with the
 * detail logged rather than returned, because an exception message is written for whoever is
 * debugging and frequently contains a table name, a query, or a path.
 */
@RestControllerAdvice
public class ApiExceptionHandler {

  private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

  @ExceptionHandler(ServiceException.class)
  public ResponseEntity<ApiResponse.Failure> handleService(ServiceException e) {
    // Expected outcomes — a forbidden action, a stale id — are not incidents. Logged at debug
    // so a permissions denial does not look like a fault in the dashboards.
    log.debug("{} — {}", e.code(), e.getMessage());
    return ResponseEntity.status(e.code().status())
        .body(ApiResponse.error(e.code().wire(), e.getMessage(), e.details()));
  }

  /** Bean-validation failures, reported field by field so the client can mark the inputs. */
  @ExceptionHandler(MethodArgumentNotValidException.class)
  public ResponseEntity<ApiResponse.Failure> handleValidation(MethodArgumentNotValidException e) {
    Map<String, String> fields = new LinkedHashMap<>();
    e.getBindingResult()
        .getFieldErrors()
        .forEach(error -> fields.putIfAbsent(error.getField(), error.getDefaultMessage()));

    return ResponseEntity.unprocessableEntity()
        .body(
            ApiResponse.error(
                ServiceException.Code.VALIDATION_FAILED.wire(),
                "That request did not pass validation",
                fields));
  }

  @ExceptionHandler({
    HttpMessageNotReadableException.class,
    MissingServletRequestParameterException.class,
    MethodArgumentTypeMismatchException.class
  })
  public ResponseEntity<ApiResponse.Failure> handleBadRequest(Exception e) {
    log.debug("Malformed request: {}", e.getMessage());
    return ResponseEntity.badRequest()
        .body(
            ApiResponse.error(
                ServiceException.Code.BAD_REQUEST.wire(), "Expected a valid JSON body", null));
  }

  @ExceptionHandler(Exception.class)
  public ResponseEntity<ApiResponse.Failure> handleUnexpected(Exception e) {
    log.error("Unhandled error at the API boundary", e);
    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
        .body(
            ApiResponse.error(
                ServiceException.Code.INTERNAL.wire(), "Something went wrong on our side.", null));
  }
}
