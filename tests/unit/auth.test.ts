import { Response, NextFunction } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../../src/middleware/auth';

describe('Authentication Middleware', () => {
  let mockRequest: Partial<AuthenticatedRequest>;
  let mockResponse: Partial<Response>;
  let nextFunction: NextFunction;

  beforeEach(() => {
    mockRequest = {
      headers: {},
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    nextFunction = jest.fn();
  });

  it('should reject request without authorization header', async () => {
    await authenticateToken(
      mockRequest as AuthenticatedRequest,
      mockResponse as Response,
      nextFunction
    );

    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockResponse.json).toHaveBeenCalledWith({
      error: 'Missing authorization header',
    });
    expect(nextFunction).not.toHaveBeenCalled();
  });

  it('should reject request with invalid authorization format', async () => {
    mockRequest.headers = {
      authorization: 'InvalidFormat',
    };

    await authenticateToken(
      mockRequest as AuthenticatedRequest,
      mockResponse as Response,
      nextFunction
    );

    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockResponse.json).toHaveBeenCalledWith({
      error: 'Invalid authorization header format. Use: Bearer <token>',
    });
    expect(nextFunction).not.toHaveBeenCalled();
  });

  it('should accept valid token and call next()', async () => {
    mockRequest.headers = {
      authorization: 'Bearer dev-token-12345',
    };

    await authenticateToken(
      mockRequest as AuthenticatedRequest,
      mockResponse as Response,
      nextFunction
    );

    expect(mockRequest.token).toBeDefined();
    expect(mockRequest.token?.name).toBe('Development Token');
    expect(nextFunction).toHaveBeenCalled();
    expect(mockResponse.status).not.toHaveBeenCalled();
  });

  it('should reject invalid token', async () => {
    mockRequest.headers = {
      authorization: 'Bearer invalid-token',
    };

    await authenticateToken(
      mockRequest as AuthenticatedRequest,
      mockResponse as Response,
      nextFunction
    );

    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockResponse.json).toHaveBeenCalledWith({
      error: 'Invalid or inactive token',
    });
    expect(nextFunction).not.toHaveBeenCalled();
  });
});
