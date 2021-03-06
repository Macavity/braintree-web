/* eslint-disable camelcase */

'use strict';

var internal = require('../../../../src/hosted-fields/internal/index');
var getFrameName = require('../../../../src/hosted-fields/internal/get-frame-name');
var events = require('../../../../src/hosted-fields/shared/constants').events;
var CreditCardForm = require('../../../../src/hosted-fields/internal/models/credit-card-form').CreditCardForm;
var Bus = require('../../../../src/lib/bus');
var analytics = require('../../../../src/lib/analytics');
var fake = require('../../../helpers/fake');
var assembleIFrames = require('../../../../src/hosted-fields/internal/assemble-iframes');
var BraintreeError = require('../../../../src/lib/braintree-error');
var Promise = require('../../../../src/lib/promise');

describe('internal', function () {
  beforeEach(function () {
    location.hash = 'fake-channel';

    this.fakeConfig = {
      fields: {
        number: {},
        cvv: {}
      }
    };
    this.cardForm = new CreditCardForm(this.fakeConfig);

    this.sandbox.stub(getFrameName, 'getFrameName').returns('cvv');
  });

  describe('initialize', function () {
    beforeEach(function () {
      internal.initialize(this.cardForm);
    });

    it('creates an input element', function () {
      var inputs = document.querySelectorAll('input');

      expect(inputs).to.have.length(1);
    });

    it('sets up autofill inputs for number input', function () {
      var inputs;

      document.querySelector('input').remove(); // reset from beforeEach

      getFrameName.getFrameName.returns('number');
      internal.initialize(this.cardForm);

      inputs = document.querySelectorAll('input');

      expect(inputs).to.have.length(4);
      expect(document.querySelector('#expiration-month-autofill-field')).to.exist;
      expect(document.querySelector('#expiration-year-autofill-field')).to.exist;
    });

    it('makes the input have a transparent background', function () {
      var input = document.querySelector('input');
      var background = window.getComputedStyle(input, null).getPropertyValue('background-color');

      expect(background.replace(/\s/g, '')).to.equal('rgba(0,0,0,0)');
    });

    it('gives the input a class of the proper type', function () {
      var input = document.querySelector('input');

      expect(input.classList.contains('cvv')).to.be.true;
    });

    it('triggers events on the bus when events occur', function () {
      var input = document.querySelector('input');

      this.sandbox.stub(CreditCardForm.prototype, 'emitEvent');

      triggerEvent('focus', input);
      triggerEvent('blur', input);
      triggerEvent('click', input);  // not whitelisted
      triggerEvent('keyup', input);  // not whitelisted

      expect(CreditCardForm.prototype.emitEvent).to.be.calledWith('cvv', 'focus');
      expect(CreditCardForm.prototype.emitEvent).to.be.calledWith('cvv', 'blur');
      expect(CreditCardForm.prototype.emitEvent).not.to.be.calledWith('cvv', 'click');
      expect(CreditCardForm.prototype.emitEvent).not.to.be.calledWith('cvv', 'keyup');
    });
  });

  describe('create', function () {
    it('creates a global bus', function () {
      var originalLocationHash = location.hash;

      location.hash = '#test-uuid';
      internal.create();
      expect(global.bus.channel).to.equal('test-uuid');

      location.hash = originalLocationHash;
    });
  });

  describe('orchestrate', function () {
    beforeEach(function () {
      var i, args;

      internal.create();

      for (i = 0; i < Bus.prototype.emit.callCount; i++) {
        args = Bus.prototype.emit.getCall(i).args;
        if (args[0] === events.FRAME_READY) {
          this.orchestrate = args[1];
          break;
        }
      }
    });

    it('posts an analytics event', function () {
      this.sandbox.stub(analytics, 'sendEvent');
      this.sandbox.stub(assembleIFrames, 'assembleIFrames').returns([]);

      this.orchestrate({
        client: fake.configuration(),
        fields: {
          number: {selector: '#foo'},
          cvv: {selector: '#boo'},
          postalCode: {selector: '#you'}
        }
      });

      expect(analytics.sendEvent).to.be.calledWith(this.sandbox.match.object, 'custom.hosted-fields.load.succeeded');
    });
  });

  describe('createTokenizationHandler', function () {
    var create = internal.createTokenizationHandler;

    beforeEach(function () {
      var self = this;
      var requestStub = this.sandbox.stub();

      this.fakeNonce = 'nonce homeboy';
      this.fakeDetails = 'yas';
      this.fakeType = 'YASS';
      this.fakeDescription = 'fake description';
      this.fakeOptions = {foo: 'bar'};
      this.binData = {commercial: 'Yes'};

      requestStub.withArgs(this.sandbox.match({api: 'clientApi'})).resolves({
        creditCards: [{
          nonce: self.fakeNonce,
          details: self.fakeDetails,
          description: self.fakeDescription,
          type: self.fakeType,
          foo: 'bar',
          binData: self.binData
        }]
      });
      requestStub.withArgs(this.sandbox.match({api: 'braintreeApi'})).resolves({
        data: {
          id: 'braintreeApi-token',
          brand: 'visa',
          last_4: '1111', // eslint-disable-line camelcase
          description: 'Visa credit card ending in - 1111',
          type: 'credit_card'
        }
      });

      this.fakeError = new Error('you done goofed');

      this.fakeError.errors = [];
      this.fakeError.details = {
        httpStatus: 500
      };

      this.sandbox.stub(analytics, 'sendEvent');

      this.details = {
        isValid: true,
        isEmpty: false,
        someOtherStuff: null
      };

      this.configuration = fake.configuration();
      delete this.configuration.gatewayConfiguration.braintreeApi;

      this.goodClient = {
        getConfiguration: function () {
          return self.configuration;
        },
        request: requestStub
      };

      this.badClient = {
        getConfiguration: function () {
          return self.configuration;
        },
        request: this.sandbox.stub().rejects(self.fakeError)
      };

      this.emptyCardForm = this.cardForm;
      this.emptyCardForm.isEmpty = function () { return true; };

      this.validCardForm = new CreditCardForm(this.fakeConfig);
      this.validCardForm.isEmpty = function () { return false; };
      this.validCardForm.invalidFieldKeys = function () { return []; };

      this.invalidCardForm = new CreditCardForm(this.fakeConfig);
      this.invalidCardForm.isEmpty = function () { return false; };
      this.invalidCardForm.invalidFieldKeys = function () { return ['cvv']; };
    });

    it('returns a function', function () {
      expect(create(this.goodClient, this.cardForm)).to.be.a('function');
    });

    it('replies with an error if tokenization fails due to network', function (done) {
      create(this.badClient, this.validCardForm)(this.fakeOptions, function (response) {
        var err = response[0];

        expect(err).to.be.an.instanceof(BraintreeError);
        expect(err.type).to.equal('NETWORK');
        expect(err.code).to.equal('HOSTED_FIELDS_TOKENIZATION_NETWORK_ERROR');
        expect(err.message).to.equal('A tokenization network error occurred.');
        expect(err.details.originalError.message).to.equal('you done goofed');
        expect(err.details.originalError.errors).to.equal(this.fakeError.errors);

        done();
      }.bind(this));
    });

    it('replies with client\'s error if tokenization fails due to authorization', function (done) {
      this.fakeError.details.httpStatus = 403;
      this.badClient.request.rejects(this.fakeError);

      create(this.badClient, this.validCardForm)(this.fakeOptions, function (response) {
        var err = response[0];

        expect(err).to.equal(this.fakeError);

        done();
      }.bind(this));
    });

    it('replies with an error if tokenization fails due to card data', function (done) {
      this.fakeError.details.httpStatus = 422;
      this.badClient.request.rejects(this.fakeError);

      create(this.badClient, this.validCardForm)(this.fakeOptions, function (response) {
        var err = response[0];

        expect(err).to.be.an.instanceof(BraintreeError);
        expect(err.type).to.equal('CUSTOMER');
        expect(err.code).to.equal('HOSTED_FIELDS_FAILED_TOKENIZATION');
        expect(err.message).to.equal('The supplied card data failed tokenization.');
        expect(err.details.originalError.message).to.equal('you done goofed');
        expect(err.details.originalError.errors).to.equal(this.fakeError.errors);

        done();
      }.bind(this));
    });

    it('replies with an error with a non-object `gateways` option', function (done) {
      create(this.goodClient, this.validCardForm)({
        gateways: 'clientApi'
      }, function (arg) {
        var err = arg[0];
        var result = arg[1];

        expect(err).to.be.an.instanceof(BraintreeError);
        expect(err.type).to.equal('MERCHANT');
        expect(err.code).to.equal('INVALID_OPTION');
        expect(err.message).to.equal('options.gateways is invalid.');
        expect(result).not.to.exist;

        done();
      });
    });

    it('replies with an error with an empty `gateways` option', function (done) {
      create(this.goodClient, this.validCardForm)({
        gateways: {}
      }, function (arg) {
        var err = arg[0];
        var result = arg[1];

        expect(err).to.be.an.instanceof(BraintreeError);
        expect(err.type).to.equal('MERCHANT');
        expect(err.code).to.equal('INVALID_OPTION');
        expect(err.message).to.equal('options.gateways is invalid.');
        expect(result).not.to.exist;

        done();
      });
    });

    it('replies with an error without a clientApi gateway', function (done) {
      create(this.goodClient, this.validCardForm)({
        gateways: {
          braintreeApi: true
        }
      }, function (arg) {
        var err = arg[0];
        var result = arg[1];

        expect(err).to.be.an.instanceof(BraintreeError);
        expect(err.type).to.equal('MERCHANT');
        expect(err.code).to.equal('INVALID_OPTION');
        expect(err.message).to.equal('options.gateways is invalid.');
        expect(result).not.to.exist;

        done();
      });
    });

    it('sends an analytics event if tokenization fails', function (done) {
      create(this.badClient, this.validCardForm)(this.fakeOptions, function () {
        expect(analytics.sendEvent).to.be.calledWith(this.badClient, 'custom.hosted-fields.tokenization.failed');

        done();
      }.bind(this));
    });

    it('replies with data if Client API tokenization succeeds', function (done) {
      create(this.goodClient, this.validCardForm)(this.fakeOptions, function (arg) {
        expect(arg).to.deep.equal([null, {
          nonce: this.fakeNonce,
          details: this.fakeDetails,
          description: this.fakeDescription,
          type: this.fakeType,
          binData: this.binData
        }]);

        done();
      }.bind(this));
    });

    it('sends an analytics event if tokenization succeeds', function (done) {
      create(this.goodClient, this.validCardForm)(this.fakeOptions, function () {
        expect(analytics.sendEvent).to.be.calledWith(this.goodClient, 'custom.hosted-fields.tokenization.succeeded');

        done();
      }.bind(this));
    });

    it('replies with an error if all fields are empty', function (done) {
      create(this.goodClient, this.emptyCardForm)(this.fakeOptions, function (response) {
        var err = response[0];

        expect(err).to.be.an.instanceof(BraintreeError);
        expect(err.type).to.equal('CUSTOMER');
        expect(err.code).to.equal('HOSTED_FIELDS_FIELDS_EMPTY');
        expect(err.message).to.equal('All fields are empty. Cannot tokenize empty card fields.');
        expect(err.details).not.to.exist;

        done();
      });
    });

    it('replies with an error when some fields are invalid', function (done) {
      create(this.goodClient, this.invalidCardForm)(this.fakeOptions, function (response) {
        var err = response[0];

        expect(err).to.be.an.instanceof(BraintreeError);
        expect(err.type).to.equal('CUSTOMER');
        expect(err.code).to.equal('HOSTED_FIELDS_FIELDS_INVALID');
        expect(err.message).to.equal('Some payment input fields are invalid. Cannot tokenize invalid card fields.');
        expect(err.details).to.deep.equal({
          invalidFieldKeys: ['cvv']
        });

        done();
      });
    });

    it('makes a client request with validate false if the vault option is not provided', function (done) {
      create(this.goodClient, this.validCardForm)(this.fakeOptions, function () {
        expect(this.goodClient.request).to.be.calledWithMatch({
          data: {
            creditCard: {
              options: {
                validate: false
              }
            }
          }
        });
        done();
      }.bind(this));
    });

    it('makes a client request without validate false if the vault option is not provided', function (done) {
      create(this.goodClient, this.validCardForm)({vault: true}, function () {
        expect(this.goodClient.request).not.to.be.calledWithMatch({
          data: {
            creditCard: {
              options: {
                validate: false
              }
            }
          }
        });
        done();
      }.bind(this));
    });

    context('when supplying additional data', function () {
      beforeEach(function () {
        var fakeConfigWithPostalCode = {
          fields: {
            number: {},
            postalCode: {}
          }
        };

        this.cardFormWithPostalCode = new CreditCardForm(fakeConfigWithPostalCode);
        this.cardFormWithPostalCode.isEmpty = function () { return false; };
        this.cardFormWithPostalCode.invalidFieldKeys = function () { return []; };

        this.fakeOptions = {
          gateways: {
            clientApi: true,
            braintreeApi: true
          }
        };

        this.configuration.gatewayConfiguration.braintreeApi = {};
        this.configuration.gatewayConfiguration.creditCards.supportedGateways.push({
          name: 'braintreeApi',
          timeout: 2000
        });
      });

      it('tokenizes with additional cardholder name', function (done) {
        this.fakeOptions.cardholderName = 'First Last';

        create(this.goodClient, this.validCardForm)(this.fakeOptions, function () {
          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'clientApi',
            data: {
              creditCard: {
                cardholderName: 'First Last'
              }
            }
          });

          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'braintreeApi',
            data: {
              cardholderName: 'First Last'
            }
          });
          done();
        }.bind(this));
      });

      it('tokenizes street address', function (done) {
        this.fakeOptions.billingAddress = {
          streetAddress: '606 Elm St'
        };

        create(this.goodClient, this.cardFormWithPostalCode)(this.fakeOptions, function () {
          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'clientApi',
            data: {
              creditCard: {
                billing_address: {
                  street_address: '606 Elm St'
                }
              }
            }
          });

          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'braintreeApi',
            data: {
              billing_address: {
                street_address: '606 Elm St'
              }
            }
          });
          done();
        }.bind(this));
      });

      it('tokenizes extended address', function (done) {
        this.fakeOptions.billingAddress = {
          extendedAddress: 'Unit 1'
        };

        create(this.goodClient, this.cardFormWithPostalCode)(this.fakeOptions, function () {
          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'clientApi',
            data: {
              creditCard: {
                billing_address: {
                  extended_address: 'Unit 1'
                }
              }
            }
          });

          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'braintreeApi',
            data: {
              billing_address: {
                extended_address: 'Unit 1'
              }
            }
          });
          done();
        }.bind(this));
      });

      it('tokenizes locality', function (done) {
        this.fakeOptions.billingAddress = {
          locality: 'Chicago'
        };

        create(this.goodClient, this.cardFormWithPostalCode)(this.fakeOptions, function () {
          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'clientApi',
            data: {
              creditCard: {
                billing_address: {
                  locality: 'Chicago'
                }
              }
            }
          });

          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'braintreeApi',
            data: {
              billing_address: {
                locality: 'Chicago'
              }
            }
          });
          done();
        }.bind(this));
      });

      it('tokenizes region', function (done) {
        this.fakeOptions.billingAddress = {
          region: 'IL'
        };

        create(this.goodClient, this.cardFormWithPostalCode)(this.fakeOptions, function () {
          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'clientApi',
            data: {
              creditCard: {
                billing_address: {
                  region: 'IL'
                }
              }
            }
          });

          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'braintreeApi',
            data: {
              billing_address: {
                region: 'IL'
              }
            }
          });
          done();
        }.bind(this));
      });

      it('tokenizes first name', function (done) {
        this.fakeOptions.billingAddress = {
          firstName: 'First'
        };

        create(this.goodClient, this.cardFormWithPostalCode)(this.fakeOptions, function () {
          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'clientApi',
            data: {
              creditCard: {
                billing_address: {
                  first_name: 'First'
                }
              }
            }
          });

          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'braintreeApi',
            data: {
              billing_address: {
                first_name: 'First'
              }
            }
          });
          done();
        }.bind(this));
      });

      it('tokenizes last name', function (done) {
        this.fakeOptions.billingAddress = {
          lastName: 'Last'
        };

        create(this.goodClient, this.cardFormWithPostalCode)(this.fakeOptions, function () {
          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'clientApi',
            data: {
              creditCard: {
                billing_address: {
                  last_name: 'Last'
                }
              }
            }
          });

          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'braintreeApi',
            data: {
              billing_address: {
                last_name: 'Last'
              }
            }
          });
          done();
        }.bind(this));
      });

      it('tokenizes company', function (done) {
        this.fakeOptions.billingAddress = {
          company: 'Company'
        };

        create(this.goodClient, this.cardFormWithPostalCode)(this.fakeOptions, function () {
          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'clientApi',
            data: {
              creditCard: {
                billing_address: {
                  company: 'Company'
                }
              }
            }
          });

          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'braintreeApi',
            data: {
              billing_address: {
                company: 'Company'
              }
            }
          });
          done();
        }.bind(this));
      });

      it('tokenizes country name', function (done) {
        this.fakeOptions.billingAddress = {
          countryName: 'United States'
        };

        create(this.goodClient, this.cardFormWithPostalCode)(this.fakeOptions, function () {
          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'clientApi',
            data: {
              creditCard: {
                billing_address: {
                  country_name: 'United States'
                }
              }
            }
          });

          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'braintreeApi',
            data: {
              billing_address: {
                country_name: 'United States'
              }
            }
          });
          done();
        }.bind(this));
      });

      it('tokenizes country code alpha 2', function (done) {
        this.fakeOptions.billingAddress = {
          countryCodeAlpha2: 'US'
        };

        create(this.goodClient, this.cardFormWithPostalCode)(this.fakeOptions, function () {
          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'clientApi',
            data: {
              creditCard: {
                billing_address: {
                  country_code_alpha2: 'US'
                }
              }
            }
          });

          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'braintreeApi',
            data: {
              billing_address: {
                country_code_alpha2: 'US'
              }
            }
          });
          done();
        }.bind(this));
      });

      it('tokenizes country code alpha 3', function (done) {
        this.fakeOptions.billingAddress = {
          countryCodeAlpha3: 'USA'
        };

        create(this.goodClient, this.cardFormWithPostalCode)(this.fakeOptions, function () {
          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'clientApi',
            data: {
              creditCard: {
                billing_address: {
                  country_code_alpha3: 'USA'
                }
              }
            }
          });

          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'braintreeApi',
            data: {
              billing_address: {
                country_code_alpha3: 'USA'
              }
            }
          });
          done();
        }.bind(this));
      });

      it('tokenizes numeric country code', function (done) {
        this.fakeOptions.billingAddress = {
          countryCodeNumeric: '840'
        };

        create(this.goodClient, this.cardFormWithPostalCode)(this.fakeOptions, function () {
          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'clientApi',
            data: {
              creditCard: {
                billing_address: {
                  country_code_numeric: '840'
                }
              }
            }
          });

          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'braintreeApi',
            data: {
              billing_address: {
                country_code_numeric: '840'
              }
            }
          });
          done();
        }.bind(this));
      });

      it('tokenizes with additional postal code data when Hosted Fields has no postal code field', function (done) {
        this.fakeOptions.billingAddress = {
          postalCode: '33333'
        };

        create(this.goodClient, this.validCardForm)(this.fakeOptions, function () {
          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'clientApi',
            data: {
              creditCard: {
                billing_address: {
                  postal_code: '33333'
                }
              }
            }
          });

          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'braintreeApi',
            data: {
              billing_address: {
                postal_code: '33333'
              }
            }
          });
          done();
        }.bind(this));
      });

      it('tokenizes with Hosted Fields postal code', function (done) {
        this.cardFormWithPostalCode.set('postalCode.value', '11111');

        create(this.goodClient, this.cardFormWithPostalCode)(this.fakeOptions, function () {
          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'clientApi',
            data: {
              creditCard: {
                billing_address: {
                  postal_code: '11111'
                }
              }
            }
          });

          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'braintreeApi',
            data: {
              billing_address: {
                postal_code: '11111'
              }
            }
          });
          done();
        }.bind(this));
      });

      it('prioritizes Hosted Fields postal code even when the field is empty', function (done) {
        this.fakeOptions.billingAddress = {
          postalCode: '33333'
        };

        this.cardFormWithPostalCode.set('postalCode.value', '');

        create(this.goodClient, this.cardFormWithPostalCode)(this.fakeOptions, function () {
          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'clientApi',
            data: {
              creditCard: {
                billing_address: {
                  postal_code: ''
                }
              }
            }
          });

          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'braintreeApi',
            data: {
              billing_address: {
                postal_code: ''
              }
            }
          });
          done();
        }.bind(this));
      });

      it('does not override other parts of the form with options', function (done) {
        this.fakeOptions.number = '3333 3333 3333 3333';

        this.cardFormWithPostalCode.set('number.value', '1111 1111 1111 1111');

        create(this.goodClient, this.cardFormWithPostalCode)(this.fakeOptions, function () {
          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'clientApi',
            data: {
              creditCard: {
                number: '1111 1111 1111 1111'
              }
            }
          });

          expect(this.goodClient.request).to.be.calledWithMatch({
            api: 'braintreeApi',
            data: {
              number: '1111 1111 1111 1111'
            }
          });
          done();
        }.bind(this));
      });

      it('does not attempt to tokenize non-whitelisted billing address options', function (done) {
        this.cardFormWithPostalCode.set('number.value', '1111 1111 1111 1111');
        this.fakeOptions.billingAddress = {
          foo: 'bar',
          baz: 'biz'
        };

        create(this.goodClient, this.cardFormWithPostalCode)(this.fakeOptions, function () {
          var clientApiRequestArgs = this.goodClient.request.args[0][0];
          var braintreeApiRequestArgs = this.goodClient.request.args[1][0];

          expect(clientApiRequestArgs.data.creditCard.billing_address.foo).to.not.exist;
          expect(clientApiRequestArgs.data.creditCard.billing_address.baz).to.not.exist;
          expect(braintreeApiRequestArgs.data.billing_address.foo).to.not.exist;
          expect(braintreeApiRequestArgs.data.billing_address.baz).to.not.exist;

          done();
        }.bind(this));
      });
    });

    it("doesn't make a request to the Braintree API if it's not enabled by gateway configuration or client-side option", function () {
      this.fakeOptions.gateways = {
        clientApi: true
      };

      create(this.goodClient, this.validCardForm)(this.fakeOptions, function () {});

      expect(this.goodClient.request).not.to.be.calledWithMatch({
        api: 'braintreeApi'
      });
    });

    it("doesn't make a request to the Braintree API if it's not enabled by gateway configuration, even if it's enabled client-side", function () {
      this.fakeOptions.gateways = {
        clientApi: true,
        braintreeApi: true
      };

      create(this.goodClient, this.validCardForm)(this.fakeOptions, function () {});

      expect(this.goodClient.request).not.to.be.calledWithMatch({
        api: 'braintreeApi'
      });
    });

    it("doesn't make a request to the Braintree API if it's not enabled by a client-side option", function () {
      this.configuration.gatewayConfiguration.creditCards.supportedGateways.push({
        name: 'braintreeApi',
        timeout: 2000
      });
      this.fakeOptions.gateways = {
        clientApi: true
      };

      create(this.goodClient, this.validCardForm)(this.fakeOptions, function () {});

      expect(this.goodClient.request).not.to.be.calledWithMatch({
        api: 'braintreeApi'
      });
    });

    it("makes a request to the Braintree API if it's enabled, in addition to the Client API", function (done) {
      this.configuration.gatewayConfiguration.braintreeApi = {};
      this.configuration.gatewayConfiguration.creditCards.supportedGateways.push({
        name: 'braintreeApi',
        timeout: 2000
      });
      this.fakeOptions.gateways = {
        clientApi: true,
        braintreeApi: true
      };

      create(this.goodClient, this.validCardForm)(this.fakeOptions, function () {
        expect(this.goodClient.request).to.be.calledWithMatch({
          api: 'clientApi',
          endpoint: 'payment_methods/credit_cards',
          method: 'post'
        });

        expect(this.goodClient.request).to.be.calledWithMatch({
          api: 'braintreeApi',
          endpoint: 'tokens',
          method: 'post',
          timeout: 2000
        });

        done();
      }.bind(this));
    });

    it('returns combined data from the Braintree and Client APIs', function (done) {
      this.configuration.gatewayConfiguration.braintreeApi = {};
      this.configuration.gatewayConfiguration.creditCards.supportedGateways.push({
        name: 'braintreeApi',
        timeout: 2000
      });
      this.fakeOptions.gateways = {
        clientApi: true,
        braintreeApi: true
      };

      this.goodClient.request = this.sandbox.stub();
      this.goodClient.request.withArgs(this.sandbox.match({api: 'clientApi'})).resolves({
        creditCards: [{
          nonce: 'clientApi-nonce',
          details: {
            cardType: 'Visa',
            lastTwo: '11'
          },
          description: 'ending in 69',
          type: 'CreditCard',
          binData: {commercial: 'Yes'}
        }]
      });
      this.goodClient.request.withArgs(this.sandbox.match({api: 'braintreeApi'})).resolves({
        data: {
          id: 'braintreeApi-token',
          brand: 'visa',
          last_4: '1111', // eslint-disable-line camelcase
          description: 'Visa credit card ending in - 1111',
          type: 'credit_card'
        }
      });

      create(this.goodClient, this.validCardForm)(this.fakeOptions, function (args) {
        var err = args[0];
        var result = args[1];

        expect(err).not.to.exist;
        expect(result).to.deep.equal({
          nonce: 'clientApi-nonce',
          braintreeApiToken: 'braintreeApi-token',
          details: {
            cardType: 'Visa',
            lastTwo: '11'
          },
          description: 'ending in 69',
          type: 'CreditCard',
          binData: {commercial: 'Yes'}
        });

        done();
      });
    });

    it('returns Braintree API data if Client API has a network failure and Braintree API succeeds', function (done) {
      this.configuration.gatewayConfiguration.braintreeApi = {};
      this.configuration.gatewayConfiguration.creditCards.supportedGateways.push({
        name: 'braintreeApi',
        timeout: 2000
      });
      this.fakeOptions.gateways = {
        clientApi: true,
        braintreeApi: true
      };

      this.goodClient.request = function (options) {
        if (options.api === 'clientApi') {
          return Promise.reject(new Error('it failed'));
        }

        return Promise.resolve({
          data: {
            id: 'braintreeApi-token',
            brand: 'visa',
            last_4: '1234', // eslint-disable-line camelcase
            description: 'Visa credit card ending in - 1234',
            type: 'credit_card'
          }
        });
      };

      create(this.goodClient, this.validCardForm)(this.fakeOptions, function (args) {
        var err = args[0];
        var result = args[1];

        expect(err).not.to.exist;
        expect(result).to.deep.equal({
          braintreeApiToken: 'braintreeApi-token',
          details: {
            cardType: 'Visa',
            lastTwo: '34'
          },
          description: 'ending in 34',
          type: 'CreditCard'
        });

        done();
      });
    });

    it('returns Client API data if it succeeds but Braintree API fails', function (done) {
      this.configuration.gatewayConfiguration.braintreeApi = {};
      this.configuration.gatewayConfiguration.creditCards.supportedGateways.push({
        name: 'braintreeApi',
        timeout: 2000
      });
      this.fakeOptions.gateways = {
        clientApi: true,
        braintreeApi: true
      };

      this.goodClient.request = function (options) {
        var error = new Error('it failed');

        error.details = {httpStatus: 500};

        if (options.api === 'clientApi') {
          return Promise.resolve({
            creditCards: [{
              nonce: 'clientApi-nonce',
              details: {
                cardType: 'Visa',
                lastTwo: '11'
              },
              description: 'ending in 69',
              type: 'CreditCard',
              binData: {commercial: 'Yes'}
            }]
          });
        }

        // braintree-api
        return Promise.reject(error);
      };

      create(this.goodClient, this.validCardForm)(this.fakeOptions, function (args) {
        var err = args[0];
        var result = args[1];

        expect(err).not.to.exist;
        expect(result).to.deep.equal({
          nonce: 'clientApi-nonce',
          details: {
            cardType: 'Visa',
            lastTwo: '11'
          },
          description: 'ending in 69',
          type: 'CreditCard',
          binData: {commercial: 'Yes'}
        });

        done();
      });
    });

    it('sends Client API error when both Client and Braintree APIs fail', function (done) {
      var fakeErr = new Error('it failed');

      fakeErr.details = {httpStatus: 500};

      this.configuration.gatewayConfiguration.braintreeApi = {};
      this.configuration.gatewayConfiguration.creditCards.supportedGateways.push({
        name: 'braintreeApi',
        timeout: 2000
      });
      this.fakeOptions.gateways = {
        clientApi: true,
        braintreeApi: true
      };

      this.goodClient.request = this.sandbox.stub();
      this.goodClient.request.withArgs(this.sandbox.match({api: 'clientApi'})).rejects(fakeErr);
      this.goodClient.request.withArgs(this.sandbox.match({api: 'braintreeApi'})).rejects(fakeErr);

      create(this.goodClient, this.validCardForm)(this.fakeOptions, function (args) {
        var err = args[0];
        var result = args[1];

        expect(err).to.be.an.instanceof(BraintreeError);
        expect(err.type).to.equal('NETWORK');
        expect(err.code).to.equal('HOSTED_FIELDS_TOKENIZATION_NETWORK_ERROR');
        expect(err.message).to.equal('A tokenization network error occurred.');
        expect(err.details.originalError).to.equal(fakeErr);

        expect(result).not.to.exist;

        done();
      });
    });

    it('sends a wrapped fail on duplicate payment method error', function (done) {
      var originalError = {
        fieldErrors: [{
          fieldErrors: [{
            code: '81724',
            field: 'creditCard',
            message: 'Already in vault'
          }]
        }]
      };
      var fakeErr = new BraintreeError({
        code: 'CLIENT_REQUEST_ERROR',
        type: BraintreeError.types.NETWORK,
        message: 'An error',
        details: {
          httpStatus: 422,
          originalError: originalError
        }
      });

      this.configuration.gatewayConfiguration.braintreeApi = {};
      this.configuration.gatewayConfiguration.creditCards.supportedGateways.push({
        name: 'braintreeApi',
        timeout: 2000
      });
      this.fakeOptions.gateways = {
        clientApi: true,
        braintreeApi: true
      };

      this.goodClient.request = this.sandbox.stub();
      this.goodClient.request.withArgs(this.sandbox.match({api: 'clientApi'})).returns(Promise.reject(fakeErr));
      this.goodClient.request.withArgs(this.sandbox.match({api: 'braintreeApi'})).returns(Promise.reject(fakeErr));

      create(this.goodClient, this.validCardForm)(this.fakeOptions, function (args) {
        var err = args[0];
        var result = args[1];

        expect(err).to.be.an.instanceof(BraintreeError);
        expect(err.type).to.equal('CUSTOMER');
        expect(err.code).to.equal('HOSTED_FIELDS_TOKENIZATION_FAIL_ON_DUPLICATE');
        expect(err.message).to.equal('This credit card already exists in the merchant\'s vault.');
        expect(err.details.originalError).to.equal(originalError);

        expect(result).not.to.exist;

        done();
      });
    });

    it('sends a wrapped cvv verification error', function (done) {
      var originalError = {
        fieldErrors: [{
          fieldErrors: [{
            code: '81736',
            field: 'cvv',
            message: 'cvv verification failed'
          }]
        }]
      };
      var fakeErr = new BraintreeError({
        code: 'CLIENT_REQUEST_ERROR',
        type: BraintreeError.types.NETWORK,
        message: 'An error',
        details: {
          httpStatus: 422,
          originalError: originalError
        }
      });

      this.configuration.gatewayConfiguration.braintreeApi = {};
      this.configuration.gatewayConfiguration.creditCards.supportedGateways.push({
        name: 'braintreeApi',
        timeout: 2000
      });
      this.fakeOptions.gateways = {
        clientApi: true,
        braintreeApi: true
      };

      this.goodClient.request = this.sandbox.stub();
      this.goodClient.request.withArgs(this.sandbox.match({api: 'clientApi'})).returns(Promise.reject(fakeErr));
      this.goodClient.request.withArgs(this.sandbox.match({api: 'braintreeApi'})).returns(Promise.reject(fakeErr));

      create(this.goodClient, this.validCardForm)(this.fakeOptions, function (args) {
        var err = args[0];
        var result = args[1];

        expect(err).to.be.an.instanceof(BraintreeError);
        expect(err.type).to.equal('CUSTOMER');
        expect(err.code).to.equal('HOSTED_FIELDS_TOKENIZATION_CVV_VERIFICATION_FAILED');
        expect(err.message).to.equal('CVV verification failed during tokenization.');
        expect(err.details.originalError).to.equal(originalError);

        expect(result).not.to.exist;

        done();
      });
    });
  });

  describe('autofillHandler', function () {
    beforeEach(function () {
      this.fieldComponent = {
        input: {
          maskValue: this.sandbox.stub(),
          updateModel: this.sandbox.stub(),
          element: {
            value: '',
            getAttribute: this.sandbox.stub(),
            setAttribute: this.sandbox.stub()
          }
        }
      };
    });

    it('returns a function', function () {
      expect(internal.autofillHandler(this.fieldComponent)).to.be.a('function');
    });

    it('returns early if there is no payload', function () {
      var handler = internal.autofillHandler(this.fieldComponent);

      handler();
      expect(getFrameName.getFrameName).to.not.be.called;
    });

    it('returns early if payload does not contain a month', function () {
      var handler = internal.autofillHandler(this.fieldComponent);

      handler({
        year: '2020'
      });
      expect(getFrameName.getFrameName).to.not.be.called;
    });

    it('returns early if payload does not contain a year', function () {
      var handler = internal.autofillHandler(this.fieldComponent);

      handler({
        month: '12'
      });
      expect(getFrameName.getFrameName).to.not.be.called;
    });

    it('noops if input is not an expiration field', function () {
      var handler = internal.autofillHandler(this.fieldComponent);

      getFrameName.getFrameName.returns('postalCode');

      handler({
        month: '12',
        year: '2020'
      });

      expect(getFrameName.getFrameName).to.be.called;
      expect(this.fieldComponent.input.updateModel).to.not.be.called;
    });

    it('updates input with month and year if frame is expiration date', function () {
      var handler = internal.autofillHandler(this.fieldComponent);

      getFrameName.getFrameName.returns('expirationDate');

      handler({
        month: '12',
        year: '2020'
      });

      expect(getFrameName.getFrameName).to.be.called;
      expect(this.fieldComponent.input.updateModel).to.be.calledOnce;
      expect(this.fieldComponent.input.updateModel).to.be.calledWith('value', '12 / 2020');
      expect(this.fieldComponent.input.element.value).to.equal('12 / 2020');
    });

    it('masks input if masking is turned on', function () {
      var handler = internal.autofillHandler(this.fieldComponent);

      this.fieldComponent.input.shouldMask = true;

      getFrameName.getFrameName.returns('expirationDate');

      handler({
        month: '12',
        year: '2020'
      });

      expect(getFrameName.getFrameName).to.be.called;
      expect(this.fieldComponent.input.updateModel).to.be.calledOnce;
      expect(this.fieldComponent.input.updateModel).to.be.calledWith('value', '12 / 2020');
      expect(this.fieldComponent.input.maskValue).to.be.calledWith('12 / 2020');
    });

    it('updates input with month if frame is expiration month', function () {
      var handler = internal.autofillHandler(this.fieldComponent);

      getFrameName.getFrameName.returns('expirationMonth');

      handler({
        month: '12',
        year: '2020'
      });

      expect(getFrameName.getFrameName).to.be.called;
      expect(this.fieldComponent.input.updateModel).to.be.calledOnce;
      expect(this.fieldComponent.input.updateModel).to.be.calledWith('value', '12');
      expect(this.fieldComponent.input.element.value).to.equal('12');
    });

    it('updates input with year if frame is expiration year', function () {
      var handler = internal.autofillHandler(this.fieldComponent);

      getFrameName.getFrameName.returns('expirationYear');

      handler({
        month: '12',
        year: '2020'
      });

      expect(getFrameName.getFrameName).to.be.called;
      expect(this.fieldComponent.input.updateModel).to.be.calledOnce;
      expect(this.fieldComponent.input.updateModel).to.be.calledWith('value', '2020');
      expect(this.fieldComponent.input.element.value).to.equal('2020');
    });

    it('formats year as 4 digit number', function () {
      var handler = internal.autofillHandler(this.fieldComponent);

      getFrameName.getFrameName.returns('expirationYear');

      handler({
        month: '12',
        year: '34'
      });

      expect(getFrameName.getFrameName).to.be.called;
      expect(this.fieldComponent.input.updateModel).to.be.calledOnce;
      expect(this.fieldComponent.input.updateModel).to.be.calledWith('value', '2034');
      expect(this.fieldComponent.input.element.value).to.equal('2034');
    });

    it('sends cvv if it exists', function () {
      var handler = internal.autofillHandler(this.fieldComponent);

      getFrameName.getFrameName.returns('cvv');

      handler({
        month: '12',
        year: '34',
        cvv: '123'
      });

      expect(getFrameName.getFrameName).to.be.called;
      expect(this.fieldComponent.input.updateModel).to.be.calledOnce;
      expect(this.fieldComponent.input.updateModel).to.be.calledWith('value', '123');
      expect(this.fieldComponent.input.element.value).to.equal('123');
    });

    it('resets placeholder if it exists to account for bug in Safari', function () {
      var handler = internal.autofillHandler(this.fieldComponent);

      this.fieldComponent.input.element.getAttribute.returns('111');
      getFrameName.getFrameName.returns('cvv');

      handler({
        month: '12',
        year: '34',
        cvv: '123'
      });

      expect(getFrameName.getFrameName).to.be.called;
      expect(this.fieldComponent.input.element.setAttribute).to.be.calledTwice;
      expect(this.fieldComponent.input.element.setAttribute).to.be.calledWith('placeholder', '');
      expect(this.fieldComponent.input.element.setAttribute).to.be.calledWith('placeholder', '111');
    });

    it('ignores setting placeholder if no placeholder on element', function () {
      var handler = internal.autofillHandler(this.fieldComponent);

      this.fieldComponent.input.element.getAttribute.returns(null);
      getFrameName.getFrameName.returns('cvv');

      handler({
        month: '12',
        year: '34',
        cvv: '123'
      });

      expect(getFrameName.getFrameName).to.be.called;
      expect(this.fieldComponent.input.element.setAttribute).to.not.be.called;
    });

    it('ignores cvv if it is not present', function () {
      var handler = internal.autofillHandler(this.fieldComponent);

      getFrameName.getFrameName.returns('cvv');

      handler({
        month: '12',
        year: '34',
        cvv: ''
      });

      expect(getFrameName.getFrameName).to.be.called;
      expect(this.fieldComponent.input.updateModel).to.not.be.called;
    });
  });
});
