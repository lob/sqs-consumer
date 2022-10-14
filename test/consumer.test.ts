import { Consumer } from '../src/index';
import { mockClient } from 'aws-sdk-client-mock';
import { ChangeMessageVisibilityBatchCommand, ChangeMessageVisibilityCommand, DeleteMessageCommand, Message, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { pEvent } from 'p-event';
import { EventEmitter } from 'stream';
import { jest } from '@jest/globals';
import { SQSError } from '../src/errors';
import 'aws-sdk-client-mock-jest';

class MockSQSServiceException extends Error {
  code: string;
  $response: {
    statusCode: number;
  };
  $fault: string;

  constructor(message: string) {
    super(message);
    this.message = message;
  }
}

const AUTHENTICATION_ERROR_TIMEOUT = 20;
const POLLING_TIMEOUT = 100;

describe('Consumer', () => {

  let handleMessage;
  let handleMessageBatch;
  const sqs = mockClient(SQSClient);
  let consumer: Consumer;
  const response = {
    Messages: [{
      ReceiptHandle: 'receipt-handle',
      MessageId: '123',
      Body: 'body'
    }]
  };

  beforeEach(() => {
    handleMessage = jest.fn().mockResolvedValue(null as never);
    handleMessageBatch = jest.fn().mockResolvedValue(null as never);

    consumer = new Consumer({
      queueUrl: 'some-queue-url',
      region: 'some-region',
      handleMessage,
      sqs: (sqs as unknown as SQSClient),
      authenticationErrorTimeout: AUTHENTICATION_ERROR_TIMEOUT
    });
    sqs.on(ReceiveMessageCommand).resolves(response);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    sqs.reset();
    jest.useRealTimers();
  });

  it('requires a queueUrl to be set', () => {
    expect(() => Consumer.create({
      region: 'some-region',
      handleMessage
    })).toThrowError();
  });

  it('requires a handleMessage or handleMessagesBatch function to be set', () => {
    expect(() => {
      new Consumer({
        handleMessage: undefined,
        region: 'some-region',
        queueUrl: 'some-queue-url'
      });
    }).toThrowError();
  });

  it('requires the batchSize option to be no greater than 10', () => {
    expect(() => {
      new Consumer({
        region: 'some-region',
        queueUrl: 'some-queue-url',
        handleMessage,
        batchSize: 11
      });
    }).toThrowError();
  });

  it('requires the batchSize option to be greater than 0', () => {
    expect(() => {
      new Consumer({
        region: 'some-region',
        queueUrl: 'some-queue-url',
        handleMessage,
        batchSize: -1
      });
    }).toThrowError();
  });

  it('requires visibilityTimeout to be set with heartbeatInterval', () => {
    expect(() => {
      new Consumer({
        region: 'some-region',
        queueUrl: 'some-queue-url',
        handleMessage,
        heartbeatInterval: 30
      });
    }).toThrowError();
  });

  it('requires heartbeatInterval to be less than visibilityTimeout', () => {
    expect(() => {
      new Consumer({
        region: 'some-region',
        queueUrl: 'some-queue-url',
        handleMessage,
        heartbeatInterval: 30,
        visibilityTimeout: 30
      });
    }).toThrowError();
  });

  describe('.create', () => {
    it('creates a new instance of a Consumer object', () => {
      const instance = Consumer.create({
        region: 'some-region',
        queueUrl: 'some-queue-url',
        batchSize: 1,
        visibilityTimeout: 10,
        waitTimeSeconds: 10,
        handleMessage
      });

      expect(instance).toBeInstanceOf(Consumer);
    });
  });

  describe('.start', () => {

    it('fires an error event when an error occurs receiving a message', async () => {
      const receiveErr = new Error('Receive error');

      sqs.onAnyCommand().rejects(receiveErr);

      consumer.start();

      const err: Error = await pEvent(consumer as EventEmitter, 'error');

      consumer.stop();
      expect(err).toBeDefined();
      expect(err.message).toBe('SQS receive message failed: Receive error');
    });

    it('retains sqs error information', async () => {
      const receiveErr = new MockSQSServiceException('Receive error');
      receiveErr.name = 'short code';
      receiveErr.$response = { statusCode: 403 };
      receiveErr.$fault = 'hostname';

      sqs.on(ReceiveMessageCommand).rejects(receiveErr);

      consumer.start();
      const err: SQSError = await pEvent(consumer as EventEmitter, 'error');
      consumer.stop();

      expect(err).toBeDefined();
      expect(err.message).toBe('SQS receive message failed: Receive error');
      expect(err.code).toBe(receiveErr.name);
      expect(err.statusCode).toBe(receiveErr.$response.statusCode);
      expect(err.hostname).toBe(receiveErr.$fault);
    });

    it('fires a timeout event if handler function takes too long', async () => {
      const handleMessageTimeout = 500;
      consumer = new Consumer({
        queueUrl: 'some-queue-url',
        region: 'some-region',
        handleMessage: () => new Promise((resolve) => setTimeout(resolve, 1000)),
        handleMessageTimeout,
        sqs: (sqs as unknown as SQSClient),
        authenticationErrorTimeout: 20
      });
      jest.useFakeTimers();

      consumer.start();
      jest.advanceTimersByTime(handleMessageTimeout);
      jest.useRealTimers();
      const err: Error = await pEvent(consumer as EventEmitter, 'timeout_error');
      consumer.stop();

      expect(err).toBeDefined();
      expect(err.message).toBe(`Message handler timed out after ${handleMessageTimeout}ms: Operation timed out.`);
    });

    it('handles unexpected exceptions thrown by the handler function', async () => {
      consumer = new Consumer({
        queueUrl: 'some-queue-url',
        region: 'some-region',
        handleMessage: () => {
          throw new Error('unexpected parsing error');
        },
        sqs: (sqs as unknown as SQSClient),
        authenticationErrorTimeout: 20
      });

      consumer.start();
      const err: Error = await pEvent(consumer as EventEmitter, 'processing_error');
      consumer.stop();

      expect(err).toBeDefined();
      expect(err.message).toBe('Unexpected message handler failure: unexpected parsing error');
    });

    it('fires an error event when an error occurs deleting a message', async () => {
      const deleteErr = new Error('Delete error');

      sqs.on(DeleteMessageCommand).rejects(deleteErr);

      consumer.start();
      const err: Error = await pEvent(consumer as EventEmitter, 'error');
      consumer.stop();

      expect(err).toBeDefined();
      expect(err.message).toBe('SQS delete message failed: Delete error');
    });

    it('fires a `processing_error` event when a non-`SQSError` error occurs processing a message', async () => {
      const processingErr = new Error('Processing error');

      handleMessage.mockRejectedValue(processingErr);

      consumer.start();
      const [err, message] = await pEvent(consumer, 'processing_error', { multiArgs: true });
      consumer.stop();

      expect((err as Error).message).toBe('Unexpected message handler failure: Processing error');
      expect((message as Message).MessageId).toBe('123');
    });

    it('fires an `error` event when an `SQSError` occurs processing a message', async () => {
      const sqsError = new SQSError('Processing error');

      handleMessage.mockResolvedValue(sqsError);
      sqs.on(DeleteMessageCommand).rejects(sqsError);

      consumer.start();
      const [err, message] = await pEvent(consumer, 'error', { multiArgs: true });
      consumer.stop();

      expect((err as Error).message).toBe('SQS delete message failed: Processing error');
      expect((message as Message).MessageId).toBe('123');
    });

    it('waits before repolling when a credentials error occurs', async () => {
      const credentialsErr = {
        name: 'CredentialsError',
        message: 'Missing credentials in config'
      };

      sqs.on(ReceiveMessageCommand).rejects(credentialsErr);
      const errorListener = jest.fn();
      consumer.on('error', errorListener);
      jest.useFakeTimers();

      consumer.start();
      await pEvent(consumer as EventEmitter, 'error');
      jest.advanceTimersByTime(AUTHENTICATION_ERROR_TIMEOUT);
      await pEvent(consumer as EventEmitter, 'error');
      consumer.stop();

      expect(errorListener).toHaveBeenCalledTimes(2);
      expect(sqs).toHaveReceivedCommandTimes(ReceiveMessageCommand, 2);
    });

    it('waits before repolling when a 403 error occurs', async () => {
      const invalidSignatureErr = {
        statusCode: 403,
        message: 'The security token included in the request is invalid'
      };
      sqs.on(ReceiveMessageCommand).rejects(invalidSignatureErr);
      const errorListener = jest.fn();
      consumer.on('error', errorListener);
      jest.useFakeTimers();

      consumer.start();
      await pEvent(consumer as EventEmitter, 'error');
      jest.advanceTimersByTime(AUTHENTICATION_ERROR_TIMEOUT);
      await pEvent(consumer as EventEmitter, 'error');
      consumer.stop();

      expect(errorListener).toHaveBeenCalledTimes(2);
      expect(sqs).toHaveReceivedCommandTimes(ReceiveMessageCommand, 2);
    });

    it('waits before repolling when a UnknownEndpoint error occurs', async () => {
      const unknownEndpointErr = {
        code: 'UnknownEndpoint',
        message: 'Inaccessible host: `sqs.eu-west-1.amazonaws.com`. This service may not be available in the `eu-west-1` region.'
      };
      sqs.on(ReceiveMessageCommand).rejects(unknownEndpointErr);
      const errorListener = jest.fn();
      consumer.on('error', errorListener);
      jest.useFakeTimers();

      consumer.start();
      await pEvent(consumer as EventEmitter, 'error');
      jest.advanceTimersByTime(AUTHENTICATION_ERROR_TIMEOUT);
      await pEvent(consumer as EventEmitter, 'error');
      consumer.stop();

      expect(errorListener).toHaveBeenCalledTimes(2);
      expect(sqs).toHaveReceivedCommandTimes(ReceiveMessageCommand, 2);
    });

    it('waits before repolling when a polling timeout is set', async () => {
      consumer = new Consumer({
        queueUrl: 'some-queue-url',
        region: 'some-region',
        handleMessage,
        sqs: (sqs as unknown as SQSClient),
        authenticationErrorTimeout: 20,
        pollingWaitTimeMs: POLLING_TIMEOUT
      });

      consumer.start();
      await pEvent(consumer as EventEmitter, 'response_processed');
      jest.useFakeTimers();
      jest.advanceTimersByTime(POLLING_TIMEOUT);
      jest.useRealTimers();
      await pEvent(consumer as EventEmitter, 'response_processed');
      consumer.stop();

      expect(sqs).toHaveReceivedCommandTimes(ReceiveMessageCommand, 2);
    });

    it('fires a message_received event when a message is received', async () => {
      consumer.start();
      const message = await pEvent(consumer as EventEmitter, 'message_received');
      consumer.stop();

      expect(message).toBe(response.Messages[0]);
    });

    it('fires a message_processed event when a message is successfully deleted', async () => {
      consumer.start();
      const message = await pEvent(consumer as EventEmitter, 'message_processed');
      consumer.stop();

      expect(message).toBe(response.Messages[0]);
    });

    it('calls the handleMessage function when a message is received', async () => {
      consumer.start();
      await pEvent(consumer as EventEmitter, 'message_processed');
      consumer.stop();

      expect(handleMessage).toBeCalledWith(response.Messages[0]);
    });

    it('deletes the message when the handleMessage function is called', async () => {
      consumer.start();
      await pEvent(consumer as EventEmitter, 'message_processed');
      consumer.stop();

      expect(sqs).toHaveReceivedCommandWith(DeleteMessageCommand, {
        QueueUrl: 'some-queue-url',
        ReceiptHandle: 'receipt-handle'
      });
    });

    it('doesn\'t delete the message when a processing error is reported', async () => {
      handleMessage.mockRejectedValue(new Error('Processing error'));

      consumer.start();
      await pEvent(consumer as EventEmitter, 'processing_error');
      consumer.stop();

      expect(sqs).not.toHaveReceivedCommand(DeleteMessageCommand);
    });

    it('consumes another message once one is processed', async () => {
      consumer.start();
      await pEvent(consumer as EventEmitter, 'response_processed');
      jest.useFakeTimers();
      jest.advanceTimersToNextTimer();
      jest.useRealTimers();
      await pEvent(consumer as EventEmitter, 'response_processed');
      consumer.stop();

      expect(handleMessage).toHaveBeenCalledTimes(2);
    });

    it('doesn\'t consume more messages when called multiple times', () => {
      sqs.on(ReceiveMessageCommand).resolves(new Promise((res) => setTimeout(res, 100)));
      consumer.start();
      consumer.start();
      consumer.start();
      consumer.start();
      consumer.start();
      consumer.stop();

      expect(sqs).toHaveReceivedCommandTimes(ReceiveMessageCommand, 1);
    });

    it('consumes multiple messages when the batchSize is greater than 1', async () => {
      sqs.on(ReceiveMessageCommand).resolves({
        Messages: [
          {
            ReceiptHandle: 'receipt-handle-1',
            MessageId: '1',
            Body: 'body-1'
          },
          {
            ReceiptHandle: 'receipt-handle-2',
            MessageId: '2',
            Body: 'body-2'
          },
          {
            ReceiptHandle: 'receipt-handle-3',
            MessageId: '3',
            Body: 'body-3'
          }
        ]
      });

      consumer = new Consumer({
        queueUrl: 'some-queue-url',
        messageAttributeNames: ['attribute-1', 'attribute-2'],
        region: 'some-region',
        handleMessage,
        batchSize: 3,
        sqs: (sqs as unknown as SQSClient)
      });

      consumer.start();

      return new Promise<void>((resolve) => {
        handleMessage
          .mockResolvedValueOnce()
          .mockResolvedValueOnce()
          .mockImplementationOnce(() => {
            expect(sqs).toHaveReceivedCommandWith(ReceiveMessageCommand, {
              QueueUrl: 'some-queue-url',
              AttributeNames: [],
              MessageAttributeNames: ['attribute-1', 'attribute-2'],
              MaxNumberOfMessages: 3,
              WaitTimeSeconds: 20,
              VisibilityTimeout: undefined
            });
            expect(handleMessage).toHaveBeenCalledTimes(3);
            consumer.stop();
            resolve();
          });
      });
    });

    it('consumes messages with message attribute \'ApproximateReceiveCount\'', async () => {
      const messageWithAttr = {
        ReceiptHandle: 'receipt-handle-1',
        MessageId: '1',
        Body: 'body-1',
        Attributes: {
          ApproximateReceiveCount: '1'
        }
      };

      sqs.on(ReceiveMessageCommand).resolves({
        Messages: [messageWithAttr]
      });

      consumer = new Consumer({
        queueUrl: 'some-queue-url',
        attributeNames: ['ApproximateReceiveCount'],
        region: 'some-region',
        handleMessage,
        sqs: (sqs as unknown as SQSClient)
      });

      consumer.start();
      const message = await pEvent(consumer as EventEmitter, 'message_received');
      consumer.stop();

      expect(sqs).toHaveReceivedCommandWith(ReceiveMessageCommand, {
        QueueUrl: 'some-queue-url',
        AttributeNames: ['ApproximateReceiveCount'],
        MessageAttributeNames: [],
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
        VisibilityTimeout: undefined
      });

      expect(message).toBe(messageWithAttr);
    });

    it('fires an emptyQueue event when all messages have been consumed', async () => {
      sqs.on(ReceiveMessageCommand).resolves({});

      consumer.start();
      await pEvent(consumer as EventEmitter, 'empty');
      consumer.stop();
    });

    it('terminates message visibility timeout on processing error', async () => {
      handleMessage.mockRejectedValue(new Error('Processing error'));

      consumer = new Consumer({
        queueUrl: 'some-queue-url',
        region: 'some-region',
        handleMessage,
        sqs: (sqs as unknown as SQSClient),
        terminateVisibilityTimeout: true
      });

      consumer.start();
      await pEvent(consumer as EventEmitter, 'processing_error');
      consumer.stop();

      expect(sqs).toHaveReceivedCommandWith(ChangeMessageVisibilityCommand, {
        QueueUrl: 'some-queue-url',
        ReceiptHandle: 'receipt-handle',
        VisibilityTimeout: 0
      });
    });

    it('does not terminate visibility timeout when `terminateVisibilityTimeout` option is false', async () => {
      handleMessage.mockRejectedValue(new Error('Processing error'));
      consumer = new Consumer({
        queueUrl: 'some-queue-url',
        region: 'some-region',
        handleMessage,
        sqs: (sqs as unknown as SQSClient),
        terminateVisibilityTimeout: false
      });

      consumer.start();
      await pEvent(consumer as EventEmitter, 'processing_error');
      consumer.stop();

      expect(sqs).not.toHaveReceivedCommand(ChangeMessageVisibilityCommand);
    });

    it('fires error event when failed to terminate visibility timeout on processing error', async () => {
      handleMessage.mockRejectedValue(new Error('Processing error'));

      const sqsError = new Error('Processing error');
      sqsError.name = 'SQSError';
      sqs.on(ChangeMessageVisibilityCommand).rejects(sqsError);
      consumer = new Consumer({
        queueUrl: 'some-queue-url',
        region: 'some-region',
        handleMessage,
        sqs: (sqs as unknown as SQSClient),
        terminateVisibilityTimeout: true
      });

      consumer.start();
      await pEvent(consumer as EventEmitter, 'error');
      consumer.stop();

      expect(sqs).toHaveReceivedCommandWith(ChangeMessageVisibilityCommand, {
        QueueUrl: 'some-queue-url',
        ReceiptHandle: 'receipt-handle',
        VisibilityTimeout: 0
      });
    });

    it('fires response_processed event for each batch', async () => {
      sqs.on(ReceiveMessageCommand).resolves({
        Messages: [
          {
            ReceiptHandle: 'receipt-handle-1',
            MessageId: '1',
            Body: 'body-1'
          },
          {
            ReceiptHandle: 'receipt-handle-2',
            MessageId: '2',
            Body: 'body-2'
          }
        ]
      });

      consumer = new Consumer({
        queueUrl: 'some-queue-url',
        messageAttributeNames: ['attribute-1', 'attribute-2'],
        region: 'some-region',
        handleMessage,
        batchSize: 2,
        sqs: (sqs as unknown as SQSClient)
      });

      consumer.start();
      await pEvent(consumer as EventEmitter, 'response_processed');
      consumer.stop();

      expect(handleMessage.mock.calls.length).toBe(2);
      expect(handleMessage).toHaveBeenCalledTimes(2);
    });

    it('calls the handleMessagesBatch function when a batch of messages is received', async () => {
      consumer = new Consumer({
        queueUrl: 'some-queue-url',
        messageAttributeNames: ['attribute-1', 'attribute-2'],
        region: 'some-region',
        handleMessageBatch,
        batchSize: 2,
        sqs: (sqs as unknown as SQSClient)
      });

      consumer.start();
      await pEvent(consumer as EventEmitter, 'response_processed');
      consumer.stop();

      expect(handleMessageBatch).toHaveBeenCalledTimes(1);
    });

    it('prefers handleMessagesBatch over handleMessage when both are set', async () => {
      consumer = new Consumer({
        queueUrl: 'some-queue-url',
        messageAttributeNames: ['attribute-1', 'attribute-2'],
        region: 'some-region',
        handleMessageBatch,
        handleMessage,
        batchSize: 2,
        sqs: (sqs as unknown as SQSClient)
      });

      consumer.start();
      await pEvent(consumer as EventEmitter, 'response_processed');
      consumer.stop();

      expect(handleMessageBatch).toHaveBeenCalledTimes(1);
      expect(handleMessage).toHaveBeenCalledTimes(0);
    });

    it('uses the correct visibility timeout for long running handler functions', async () => {
      consumer = new Consumer({
        queueUrl: 'some-queue-url',
        region: 'some-region',
        handleMessage: () => new Promise((resolve) => setTimeout(resolve, 75000)),
        sqs: (sqs as unknown as SQSClient),
        visibilityTimeout: 40,
        heartbeatInterval: 30
      });
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
      jest.useFakeTimers();

      consumer.start();
      await pEvent(consumer as EventEmitter, 'message_received');
      jest.advanceTimersByTime(75000);
      jest.useRealTimers();
      await pEvent(consumer as EventEmitter, 'message_processed');
      consumer.stop();

      expect(sqs).toHaveReceivedCommandWith(ChangeMessageVisibilityCommand, {
        QueueUrl: 'some-queue-url',
        ReceiptHandle: 'receipt-handle',
        VisibilityTimeout: 40
      });
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    });

    it('passes in the correct visibility timeout for long running batch handler functions', async () => {
      sqs.on(ReceiveMessageCommand).resolves({
        Messages: [
          { MessageId: '1', ReceiptHandle: 'receipt-handle-1', Body: 'body-1' },
          { MessageId: '2', ReceiptHandle: 'receipt-handle-2', Body: 'body-2' },
          { MessageId: '3', ReceiptHandle: 'receipt-handle-3', Body: 'body-3' }
        ]
      });
      consumer = new Consumer({
        queueUrl: 'some-queue-url',
        region: 'some-region',
        handleMessageBatch: () => new Promise((resolve) => setTimeout(resolve, 75000)),
        batchSize: 3,
        sqs: (sqs as unknown as SQSClient),
        visibilityTimeout: 40,
        heartbeatInterval: 30
      });
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
      jest.useFakeTimers();

      consumer.start();
      await pEvent(consumer as EventEmitter, 'message_received');
      jest.advanceTimersByTime(75000);
      jest.useRealTimers();
      await pEvent(consumer as EventEmitter, 'message_processed');
      consumer.stop();

      expect(sqs).toHaveReceivedCommandWith(ChangeMessageVisibilityBatchCommand, {
        QueueUrl: 'some-queue-url',
        Entries: [
          { Id: '1', ReceiptHandle: 'receipt-handle-1', VisibilityTimeout: 40 },
          { Id: '2', ReceiptHandle: 'receipt-handle-2', VisibilityTimeout: 40 },
          { Id: '3', ReceiptHandle: 'receipt-handle-3', VisibilityTimeout: 40 }
        ]
      });
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    });

    it('emit error when changing visibility timeout fails', async () => {
      sqs.on(ReceiveMessageCommand).resolves({
        Messages: [
          { MessageId: '1', ReceiptHandle: 'receipt-handle-1', Body: 'body-1' }
        ]
      });
      consumer = new Consumer({
        queueUrl: 'some-queue-url',
        region: 'some-region',
        handleMessage: () => new Promise((resolve) => setTimeout(resolve, 75000)),
        sqs: (sqs as unknown as SQSClient),
        visibilityTimeout: 40,
        heartbeatInterval: 30
      });

      const receiveErr = new MockSQSServiceException('failed');
      sqs.on(ChangeMessageVisibilityCommand).rejects(receiveErr);
      consumer.on('error', jest.fn());

      jest.useFakeTimers();
      consumer.start();

      await pEvent(consumer as EventEmitter, 'message_received');

      jest.advanceTimersByTime(75000);
      jest.useRealTimers();
      const [err] = await Promise.all([pEvent(consumer as EventEmitter, 'error')]);

      consumer.stop();

      expect(err).toBeDefined();
      expect(err.message).toBe('Error changing visibility timeout: failed');
    });

    it('emit error when changing visibility timeout fails for batch handler functions', async () => {
      sqs.on(ReceiveMessageCommand).resolves({
        Messages: [
          { MessageId: '1', ReceiptHandle: 'receipt-handle-1', Body: 'body-1' },
          { MessageId: '2', ReceiptHandle: 'receipt-handle-2', Body: 'body-2' }
        ]
      });
      consumer = new Consumer({
        queueUrl: 'some-queue-url',
        region: 'some-region',
        handleMessageBatch: () => new Promise((resolve) => setTimeout(resolve, 75000)),
        sqs: (sqs as unknown as SQSClient),
        batchSize: 2,
        visibilityTimeout: 40,
        heartbeatInterval: 30
      });

      const receiveErr = new MockSQSServiceException('failed');
      sqs.on(ChangeMessageVisibilityBatchCommand).rejects(receiveErr);
      consumer.on('error', jest.fn());

      jest.useFakeTimers();
      consumer.start();

      await pEvent(consumer as EventEmitter, 'message_received');

      jest.advanceTimersByTime(75000);
      jest.useRealTimers();
      const [err] = await Promise.all([pEvent(consumer as EventEmitter, 'error')]);

      consumer.stop();

      expect(err).toBeDefined();
      expect(err.message).toBe('Error changing visibility timeout: failed');
    });

  });

  describe('.stop', () => {

    it('stops the consumer polling for messages', async () => {
      consumer.start();
      consumer.stop();

      jest.useFakeTimers();
      jest.runAllTimers();
      jest.useRealTimers();
      await pEvent(consumer as EventEmitter, 'stopped');

      expect(handleMessage).toHaveBeenCalled();
    });

    it('fires a stopped event only once when stopped multiple times', async () => {
      const handleStop = jest.fn().mockReturnValue(null);

      consumer.on('stopped', handleStop);

      consumer.start();
      consumer.stop();
      consumer.stop();
      consumer.stop();

      jest.useFakeTimers();
      jest.runAllTimers();
      jest.useRealTimers();
      await pEvent(consumer as EventEmitter, 'stopped');

      expect(handleStop).toHaveBeenCalled();
    });

    it('fires a stopped event a second time if started and stopped twice', async () => {
      const handleStop = jest.fn().mockReturnValue(null);

      consumer.on('stopped', handleStop);

      consumer.start();
      consumer.stop();
      consumer.start();
      consumer.stop();

      await pEvent(consumer as EventEmitter, 'stopped');
      await pEvent(consumer as EventEmitter, 'stopped');

      expect(handleStop).toHaveBeenCalledTimes(2);
    });

  });

  describe('isRunning', () => {

    it('returns true if the consumer is polling', () => {
      consumer.start();
      expect(consumer.isRunning).toBeTruthy();
      consumer.stop();
    });

    it('returns false if the consumer is not polling', () => {
      consumer.start();
      consumer.stop();
      expect(consumer.isRunning).toBeFalsy();
    });

  });

  describe('delete messages property', () => {
    beforeEach(() => {
      consumer = new Consumer({
        queueUrl: 'some-queue-url',
        region: 'some-region',
        handleMessage,
        sqs: (sqs as unknown as SQSClient),
        authenticationErrorTimeout: 20,
        shouldDeleteMessages: false
      });
    });

    it('doesn\'t delete the message when the handleMessage function is called', async () => {
      handleMessage.mockResolvedValue();

      consumer.start();
      await pEvent(consumer as EventEmitter, 'message_processed');
      consumer.stop();

      expect(sqs).not.toHaveReceivedCommand(DeleteMessageCommand);
    });
  });
});
