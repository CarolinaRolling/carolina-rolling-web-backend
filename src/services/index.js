// ============= SERVICES INDEX =============
// Export all services

const WorkOrderService = require('./WorkOrderService');
const WorkOrderPartService = require('./WorkOrderPartService');
const PONumberService = require('./PONumberService');
const InboundOrderService = require('./InboundOrderService');

// Factory function to create services with models
function createServices(models) {
  return {
    workOrderService: new WorkOrderService(models),
    workOrderPartService: new WorkOrderPartService(models),
    poNumberService: new PONumberService(models),
    inboundOrderService: new InboundOrderService(models)
  };
}

module.exports = {
  WorkOrderService,
  WorkOrderPartService,
  PONumberService,
  InboundOrderService,
  createServices
};
