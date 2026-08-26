module fifo_dut(
  input clk,
  input reset,
  input push,
  input pop,
  input [31:0] data_in,
  output reg [31:0] data_out,
  output empty,
  output full
);
  reg [31:0] memory [0:15];
  reg [4:0] count;
  reg [3:0] read_pointer;
  reg [3:0] write_pointer;

  assign empty = count == 0;
  assign full = count == 16;

  always @(posedge clk) begin
    if (reset) begin
      count <= 0;
      read_pointer <= 0;
      write_pointer <= 0;
      data_out <= 0;
    end else begin
      if (push && !full) begin
        memory[write_pointer] <= data_in;
        write_pointer <= write_pointer + 1'b1;
        count <= count + 1'b1;
      end
      if (pop && !empty) begin
        data_out <= memory[read_pointer];
        read_pointer <= read_pointer + 1'b1;
        count <= count - 1'b1;
      end
    end
  end
endmodule

module fifo_bench;
  integer i;
  reg clk;
  reg reset;
  reg push;
  reg pop;
  reg [31:0] data_in;
  wire [31:0] data_out;
  wire empty;
  wire full;

  fifo_dut dut(
    .clk(clk), .reset(reset), .push(push), .pop(pop),
    .data_in(data_in), .data_out(data_out), .empty(empty), .full(full)
  );

  initial begin
    clk = 0;
    reset = 1;
    push = 0;
    pop = 0;
    data_in = 0;
    repeat (2) @(negedge clk);
    reset = 0;
    for (i = 0; i < 5000; i = i + 1) begin
      @(negedge clk);
      data_in = i ^ 32'h5a5aa5a5;
      push = 1;
      pop = 0;
      @(negedge clk);
      push = 0;
      pop = 1;
      @(negedge clk);
      pop = 0;
      if (data_out !== (i ^ 32'h5a5aa5a5)) begin
        $display("FAIL fifo");
        $finish;
      end
    end
    if (!empty || full)
      $display("FAIL fifo");
    else
      $display("PASS fifo");
    $finish;
  end

  always #1 clk = ~clk;
endmodule
